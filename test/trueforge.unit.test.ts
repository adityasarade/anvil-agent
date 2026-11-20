/**
 * Pure unit tests for the TrueForge runtime helpers (no server needed): error
 * classification on real provider messages, tool-result summaries, call unwrapping
 * and delta merging in the event translator.
 */
import { describe, expect, it } from 'vitest';
import type { UiEvent } from '../src/shared/contracts';
import { unknownToolDenial } from '../src/shared/contracts';
import { classifyError, isModelError } from '../src/trueforge/errors';
import { substituteModel } from '../src/trueforge';
import { TurnTranslator, summarizeToolContent, toToolCallInfo } from '../src/trueforge/translate';

describe('classifyError', () => {
  it.each([
    ['[Model Error] Request failed (400): API key not valid. Please pass a valid API key.', 'auth'], // Gemini, observed live
    ['[Model Error] Request failed (401): Invalid API Key', 'auth'], // Groq, observed live
    ['[Model Error] Request failed (401): Incorrect API key provided: sk-inval*******-key.', 'auth'],
    ['[Model Error] Request failed (403): permission denied', 'auth'],
    ['[Model Error] Request failed (404): models/gemini-9 is not found for API version v1beta', 'auth'],
    ['[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9909', 'transient'],
    ['[Model Error] Request failed (429): Resource has been exhausted (e.g. check quota).', 'transient'],
    ['[Model Error] Request failed (503): The model is overloaded.', 'transient'],
    ['[Model Error] Request failed (500): internal', 'transient'],
    ['[Model Error] Request failed (400): Request contains an invalid argument.', 'model'],
    ['[Model Error] Request failed (413): Request too large on tokens per minute (TPM): Limit 8000, Requested 20222, reduce your message size and try again.', 'model'],
    ['[Model Error] maximum context length exceeded, try again', 'model'],
    ['Iteration limit reached', 'other'],
    ['MCP error -32001: Request timed out', 'other'],
  ])('%s -> %s', (msg, expected) => {
    expect(classifyError(msg)).toBe(expected);
  });

  it('treats session-creation rejections as model errors', () => {
    expect(isModelError('Unknown model "x/y" — provider not configured')).toBe(false);
    expect(classifyError('Unknown model "x/y" — provider not configured', { modelError: true })).toBe('auth');
  });
});

describe('summarizeToolContent', () => {
  it('detects {"error": …} payloads, denials and MCP text content', () => {
    expect(summarizeToolContent('{"error":[{"type":"text","text":"MCP error -32001: Request timed out"}]}')).toEqual({
      ok: false,
      denied: false,
      summary: 'MCP error -32001: Request timed out',
    });
    const denied = summarizeToolContent('{"error":[{"type":"text","text":"{\\"error\\":\\"User denied tool call: review cancelled\\"}"}]}');
    expect(denied.ok).toBe(false);
    expect(denied.denied).toBe(true);
    expect(denied.summary).toContain('review cancelled');
    expect(summarizeToolContent('[{"type":"text","text":"Applied all 2 hunks"}]')).toEqual({ ok: true, denied: false, summary: 'Applied all 2 hunks' });
    expect(summarizeToolContent('x'.repeat(1000)).summary.length).toBeLessThanOrEqual(300);
  });
});

describe('toToolCallInfo', () => {
  it('unwraps the deferred call_tool wrapper', () => {
    const info = toToolCallInfo(
      {
        id: 'c1',
        function: { name: 'call_tool', arguments: JSON.stringify({ mcp_server: 'anvil-workspace-1234', tool_name: 'edit_file', input: { path: 'a.py', edits: [] } }) },
        toolInfo: { type: 'truefoundry-system', name: 'call_tool' },
      },
      'main',
    );
    expect(info).toEqual({ callId: 'c1', threadId: 'main', name: 'edit_file', server: 'anvil-workspace-1234', args: { path: 'a.py', edits: [] } });
    const direct = toToolCallInfo({ id: 'c2', function: { name: 'read_file', arguments: '{"path":"a.py"}' }, toolInfo: { type: 'mcp', name: 'read_file', serverName: 'anvil-editor' } }, 'sub-1');
    expect(direct).toMatchObject({ name: 'read_file', server: 'anvil-editor', threadId: 'sub-1', args: { path: 'a.py' } });
  });

  it('denies unresolved wrappers and unknown approval names', () => {
    const unresolved = toToolCallInfo({ id: 'c1', function: { name: 'call_tool', arguments: '{"tool_' } }, 'main');
    expect(unknownToolDenial(unresolved.name)).toEqual({
      status: 'deny', reason: 'Anvil could not resolve this tool call; please issue it again.',
    });
    expect(unknownToolDenial('unrecognized')).toMatchObject({ status: 'deny' });
    expect(unknownToolDenial('read_file')).toBeUndefined();
  });
});

describe('TurnTranslator', () => {
  it('renders structured subagent output as readable findings rather than a message envelope', () => {
    const events: UiEvent[] = [];
    const tr = new TurnTranslator('run', event => events.push(event));
    tr.handle({ type: 'thread.done', id: 'end', threadId: 'scout', state: {
      status: 'done', output: { type: 'model.message', id: 'message', content: 'src/app.py:1-4 - application entry point' },
    } });
    expect(events[0]).toMatchObject({ type: 'subagent.done', ok: true, output: 'src/app.py:1-4 - application entry point' });
  });

  it('merges deltas, emits only new text, tracks streaming tool calls and compaction', () => {
    const out: UiEvent[] = [];
    const tr = new TurnTranslator('run', (e) => out.push(e));
    tr.handle({ type: 'turn.created', id: 'e1', turnId: 't1' });
    tr.handle({ type: 'model.message', id: 'm1', threadId: 'main' });
    tr.handle({ type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'Hel', reasoningContent: 'hmm' });
    tr.handle({ type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'lo' });
    tr.handle({
      type: 'model.message.delta',
      id: 'm1',
      threadId: 'main',
      toolCalls: [{ index: 0, id: 'c1', function: { name: 'call_tool', arguments: '{"mcp_server":"anvil-editor","tool_name":"write_file",' }, toolInfo: { type: 'truefoundry-system', name: 'call_tool' } }],
    });
    tr.handle({ type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: '"input":{"path":"n.py","content":"x"}}' } }], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } });
    const refs = tr.handle({ type: 'tool.approval_required', id: 'e2', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] });
    expect(refs).toEqual([{ callId: 'c1', sourceEventId: 'm1', threadId: 'main' }]);
    expect(tr.resolveCall(refs![0])).toMatchObject({ name: 'write_file', args: { path: 'n.py', content: 'x' } });
    tr.handle({ type: 'thread.context_compaction_started', id: 'e3', threadId: 'main', trigger: { type: 'context_threshold_exceeded', contextTokens: 900, thresholdTokens: 800 } });
    tr.handle({ type: 'turn.done', id: 'e4', state: { status: 'done', output: { content: 'Hello' } } });

    expect(out.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text)).toEqual(['Hel', 'lo']);
    expect(out.find((e) => e.type === 'reasoning.delta')).toMatchObject({ text: 'hmm' });
    const calls = out.filter((e) => e.type === 'tool.call') as Extract<UiEvent, { type: 'tool.call' }>[];
    expect(calls[0]).toMatchObject({ status: 'streaming', name: 'write_file', server: 'anvil-editor' });
    expect(calls.at(-1)).toMatchObject({ status: 'running', name: 'write_file', args: { path: 'n.py', content: 'x' } });
    expect(out.find((e) => e.type === 'compaction')).toMatchObject({ phase: 'started', contextTokens: 900, thresholdTokens: 800 });
    expect(tr.outcome).toEqual({ status: 'done', text: 'Hello' });
    expect(tr.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(tr.lastEventId).toBe('e4');
  });
});

describe('substituteModel', () => {
  it('replaces ${PRIMARY_MODEL} and forces model.name', () => {
    const m = substituteModel({ model: { name: '${PRIMARY_MODEL}', params: { temperature: 0 } }, instructions: 'use ${PRIMARY_MODEL}' }, 'groq/gpt-oss-120b');
    expect(m).toEqual({ model: { name: 'groq/gpt-oss-120b', params: { temperature: 0 } }, instructions: 'use groq/gpt-oss-120b' });
  });
});

import { retryDelayMs as _retryDelayMs, isRateLimited as _isRateLimited } from '../src/trueforge/errors';
import { describe as _describe, it as _it, expect as _expect } from 'vitest';

_describe('retryDelayMs', () => {
  _it('waits longer for quota errors and honours retry hints', () => {
    _expect(_isRateLimited('[Model Error] Request failed (429): You exceeded your current quota')).toBe(true);
    _expect(_retryDelayMs('[Model Error] Request failed (429): quota', 1)).toBe(15_000);
    _expect(_retryDelayMs('[Model Error] Request failed (429): quota', 3)).toBe(60_000);
    _expect(_retryDelayMs('Please retry in 21.4s.', 1)).toBe(21_900);
    _expect(_retryDelayMs('Please try again in 3.825s.', 1)).toBe(4_325);
    _expect(_retryDelayMs('[Model Error] Request failed (503): high demand', 2)).toBe(10_000);
    _expect(_retryDelayMs('[Model Error] Cannot connect to API: connect ECONNREFUSED', 2)).toBe(2_000);
    _expect(_retryDelayMs('(429) quota', 1, 10)).toBe(150);
  });
});
