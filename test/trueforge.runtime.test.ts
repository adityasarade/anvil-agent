import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartRunOptions, UiEvent } from '../src/shared/contracts';
import { createTrueForgeService } from '../src/trueforge';
import { requestJson } from '../src/trueforge/http';

const sessions = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  createTurnStream: vi.fn(),
  createTurnEvents: vi.fn(),
  getTurn: vi.fn(),
  subscribeToTurn: vi.fn(),
}));

vi.mock('@truefoundry/trueforge-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@truefoundry/trueforge-sdk')>(),
  TrueForge: class { sessions = sessions; },
}));
vi.mock('../src/trueforge/http', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/trueforge/http')>(),
  requestJson: vi.fn(),
}));

const log = { info() {}, warn() {}, error() {}, debug() {} };
const created = { type: 'turn.created', id: 'created', turnId: 'turn-1' };
const completed = { type: 'turn.done', id: 'done', state: { status: 'done', output: { content: 'done' } } };

function start(overrides: Partial<StartRunOptions> = {}, models = ['fake/model']) {
  const service = createTrueForgeService({
    agentsDir: 'agents',
    mcp: () => ({ url: 'http://localhost/mcp', token: 'token' }),
    mcpServerName: 'anvil-current-beef',
    settings: () => ({
      trueforgeUrl: 'http://localhost',
      models,
      retryMaxAttempts: 1,
      coderAgent: 'anvil-coder',
      inlineAgent: 'anvil-inline',
    }),
    log,
  });
  const events: UiEvent[] = [];
  const handle = service.startRun({
    kind: 'agent',
    prompt: 'Update the files',
    onEvent: (event) => events.push(event),
    onApproval: async () => ({ status: 'allow' }),
    ...overrides,
  });
  return { handle, events };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requestJson).mockImplementation(async (_url, _method, route) => {
    if (route === '/api/v1/models') return { data: [{ name: 'fake/model' }] };
    return { data: [{ id: 'agent-1', name: 'anvil-coder', manifest: {
      model: { name: 'fake/model' },
      instructions: 'Use anvil-editor or anvil-editor-dead.',
      mcp_servers: [{ name: 'anvil-editor-dead' }, { name: 'other-server' }],
    } }] };
  });
  sessions.create.mockResolvedValue({ data: { id: 'session-1' } });
  sessions.createTurnStream.mockImplementation(async function* () { yield created; });
});

afterEach(() => vi.useRealTimers());

describe('workspace MCP names and batch approvals', () => {
  it('retargets the named agent’s editor MCP server to this workspace when creating an inline spec', async () => {
    sessions.getTurn.mockResolvedValue({ data: { state: completed.state } });
    const { handle } = start();
    expect(await handle.done).toMatchObject({ status: 'done' });
    expect(sessions.create.mock.calls[0][0].agent.spec).toMatchObject({
      instructions: 'Use anvil-current-beef or anvil-current-beef.',
      mcpServers: [{ name: 'anvil-current-beef' }, { name: 'other-server' }],
    });
  });

  it('denies same-path edits and commands after edits within one approval batch', async () => {
    const tools = [
      { name: 'edit_file', args: { path: 'app.py' } },
      { name: 'write_file', args: { path: './app.py' } },
      { name: 'edit_file', args: { path: 'other.py' } },
      { name: 'run_command', args: { command: 'pytest' } },
    ].map(({ name, args }, index) => ({ id: `call-${index}`, function: { name, arguments: JSON.stringify(args) } }));
    let posted!: () => void;
    const allPosted = new Promise<void>((resolve) => { posted = resolve; });
    sessions.createTurnEvents.mockImplementation(async () => {
      if (sessions.createTurnEvents.mock.calls.length === tools.length) posted();
    });
    sessions.createTurnStream.mockImplementation(async function* () {
      yield created;
      yield { type: 'model.message', id: 'message', threadId: 'main', finishReason: 'tool_calls', toolCalls: tools };
      yield { type: 'tool.approval_required', id: 'approvals', threadId: 'main', toolCalls: tools.map(({ id }) => ({ id, sourceEventId: 'message' })) };
      await allPosted;
      yield completed;
    });
    const onApproval = vi.fn(async () => ({ status: 'allow' as const }));
    const { handle } = start({ onApproval });
    expect(await handle.done).toMatchObject({ status: 'done' });
    expect(onApproval.mock.calls).toHaveLength(2);
    const defer = { status: 'deny', reason: 'Issue this call again after the previous tool results arrive.' };
    expect(sessions.createTurnEvents.mock.calls.map(([, , body]) => body.events[0].approval)).toEqual([
      { status: 'allow' }, defer, { status: 'allow' }, defer,
    ]);
  });
});

describe('stream recovery', () => {
  it.each(['getTurn', 'subscribeToTurn'] as const)('ends on a 404 from %s', async (method) => {
    sessions.getTurn.mockResolvedValue({ data: { state: { status: 'paused' } } });
    sessions[method].mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 }));
    const { handle, events } = start();
    expect(await handle.done).toMatchObject({ status: 'error', error: 'TrueForge session no longer exists' });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', status: 'error', error: 'TrueForge session no longer exists' });
    expect(sessions[method]).toHaveBeenCalledTimes(1);
  });

  it('ends after ten recovery failures', async () => {
    vi.useFakeTimers();
    sessions.getTurn.mockResolvedValue({ data: { state: { status: 'paused' } } });
    sessions.subscribeToTurn.mockRejectedValue(new Error('Rejected cursor'));
    const { handle } = start();
    await vi.runAllTimersAsync();
    expect(await handle.done).toMatchObject({ status: 'error', error: 'Could not recover the TrueForge stream after 10 attempts: Rejected cursor' });
    expect(sessions.subscribeToTurn).toHaveBeenCalledTimes(10);
  });
});

it.each(['approved', 'responded'])('continues from the failed turn after a write was %s', async (sideEffect) => {
  vi.useFakeTimers();
  vi.mocked(requestJson).mockImplementation(async (_url, _method, route) => {
    if (route === '/api/v1/models') return { data: [{ name: 'fake/model' }, { name: 'fake/second' }] };
    return { data: [{ id: 'agent-1', name: 'anvil-coder', manifest: { model: { name: 'fake/model' } } }] };
  });
  const call = { id: 'write', function: { name: 'write_file', arguments: '{"path":"app.py","content":"x"}' } };
  let posted!: () => void;
  const approvalPosted = new Promise<void>((resolve) => { posted = resolve; });
  sessions.createTurnEvents.mockImplementation(async () => posted());
  sessions.createTurnStream.mockImplementationOnce(async function* () {
    yield created;
    yield { type: 'model.message', id: 'message', threadId: 'main', finishReason: 'tool_calls', toolCalls: [call] };
    if (sideEffect === 'approved') {
      yield { type: 'tool.approval_required', id: 'approval', toolCalls: [{ id: call.id, sourceEventId: 'message' }] };
      await approvalPosted;
    } else {
      yield { type: 'tool.response', id: 'result', toolCallId: call.id, content: 'Created app.py' };
    }
    yield { type: 'turn.done', id: 'error', state: { status: 'error', message: '[Model Error] (503) model unavailable' } };
  }).mockImplementationOnce(async function* () { yield completed; });
  const { handle } = start({}, ['fake/model', 'fake/second']);
  await vi.runAllTimersAsync();
  expect(await handle.done).toMatchObject({ status: 'done', model: 'fake/second' });
  expect(sessions.createTurnStream.mock.calls[1][1]).toMatchObject({
    previousTurnId: 'turn-1',
    input: [{ type: 'user.message', content: expect.stringContaining('Continue the same task from where it stopped') }],
  });
});
