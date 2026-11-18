/**
 * TrueForge runtime: Anvil is a client of a local TrueForge agent harness. This module
 * registers the editor MCP server and the agent definitions, creates sessions, streams
 * turns, drives TrueForge tool approvals into the editor review, and implements
 * client-side retry with backoff plus automatic model fallback (TrueForge has none).
 *
 * Pure Node: no runtime 'vscode' import, everything is injected.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TrueForge, serialization } from '@truefoundry/trueforge-sdk';
import type {
  ApprovalDecision,
  RunHandle,
  RunKind,
  RunResult,
  StartRunOptions,
  ToolCallInfo,
  TrueForgeHealth,
  TrueForgeService,
  UiEvent,
} from '../shared/contracts';
import { APPROVAL_TOOLS, EDIT_TOOLS, MCP_SERVER_NAME, TOOL_NAMES } from '../shared/contracts';
import type { Logger } from '../shared/log';
import { classifyError, errorMessage, isConnectionError, isRateLimited, retryDelayMs, shortError } from './errors';
import { TrueForgeHttpError, TrueForgeUnreachableError, apiErrorMessage, requestJson } from './http';
import { TurnTranslator, toToolCallInfo, type ApprovalRef, type TurnOutcome } from './translate';

export { classifyError, isModelError } from './errors';
export { summarizeToolContent, toToolCallInfo, TurnTranslator } from './translate';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TrueForgeSettings {
  trueforgeUrl: string;
  models: string[];
  retryMaxAttempts: number;
  coderAgent: string;
  inlineAgent: string;
}

export interface TrueForgeServiceDeps {
  /** Directory holding the bundled agent definitions (agents/*.json). config/ is its sibling. */
  agentsDir: string;
  settings: () => TrueForgeSettings;
  mcp: () => { url: string; token: string };
  mcpServerName?: string;
  resolvePath?: (path: string) => string;
  log: Logger;
  /** Test hook: base backoff delay (default 1000 ms, doubling per attempt). */
  backoffBaseMs?: number;
}

interface WireAgent {
  id: string;
  name: string;
  description?: string;
  manifest: Record<string, any>;
}

interface AgentFile {
  name: string;
  description: string;
  manifest: Record<string, any>;
}

const PRIMARY_PLACEHOLDER = '${PRIMARY_MODEL}';
export const MCP_TOKEN_HEADER = 'x-anvil-token';
export const MCP_DESCRIPTION =
  "Anvil editor tools for the user's open VS Code workspace: budgeted context retrieval, repository map, code search, " +
  'symbol lookup, line-ranged file reads, diagnostics, reviewed file edits and shell commands.';

type TurnResult = TurnOutcome & { turnId?: string; fatal?: boolean; progressed?: boolean; hadSideEffects?: boolean };

interface RunState {
  readonly runId: string;
  readonly kind: RunKind;
  readonly opts: StartRunOptions;
  readonly startedAt: number;
  readonly abort: AbortController;
  sessionId?: string;
  cancelled: boolean;
  finished: boolean;
  started: boolean;
  model: string;
  modelsTried: string[];
  text: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  approvalChain: Promise<void>;
  pendingApprovals: Set<string>;
  preStart: UiEvent[];
  turnInFlight: boolean;
  /** Translator of the turn currently streaming (for partial text on cancel). */
  current?: TurnTranslator;
  cancelSignal: Promise<void>;
  fireCancel: () => void;
  resolveDone: (r: RunResult) => void;
}

export function createTrueForgeService(deps: TrueForgeServiceDeps): TrueForgeService {
  const { log } = deps;
  const mcpServerName = deps.mcpServerName ?? MCP_SERVER_NAME;
  const runsBySession = new Map<string, RunState>();
  const lastGoodTurn = new Map<string, string>();
  const sessionModel = new Map<string, string>();
  const backoffBase = deps.backoffBaseMs ?? 1000;
  let client: TrueForge | undefined;
  let clientUrl = '';

  const baseUrl = (): string => (deps.settings().trueforgeUrl || 'http://127.0.0.1:8790').trim().replace(/\/+$/, '');

  function sdk(): TrueForge {
    const url = baseUrl();
    if (!client || clientUrl !== url) {
      client = new TrueForge({ baseUrl: url, timeoutInSeconds: 3600, maxRetries: 0 });
      clientUrl = url;
    }
    return client;
  }

  /* ───────────── registry / settings (raw JSON, wire format) ───────────── */

  async function health(): Promise<TrueForgeHealth> {
    const url = baseUrl();
    try {
      const r = await requestJson<{ status?: string; version?: string }>(url, 'GET', '/healthz', { timeoutMs: 4000 });
      return { ok: true, url, version: r?.version };
    } catch (err) {
      return { ok: false, url, error: err instanceof TrueForgeUnreachableError ? err.message : errorMessage(err) };
    }
  }

  async function listModels(): Promise<string[]> {
    const r = await requestJson<{ data?: Array<{ name: string }> }>(baseUrl(), 'GET', '/api/v1/models');
    return (r?.data ?? []).map((m) => m.name).filter(Boolean);
  }

  async function preferredChain(): Promise<string[]> {
    const configDir = path.join(deps.agentsDir, '..', 'config');
    for (const file of ['models.json', 'models.example.json']) {
      try {
        const cfg = JSON.parse(await fs.readFile(path.join(configDir, file), 'utf8'));
        if (Array.isArray(cfg?.chain)) return cfg.chain.filter((m: unknown) => typeof m === 'string');
      } catch {
        /* try next */
      }
    }
    return [];
  }

  async function modelChain(): Promise<string[]> {
    const configured = await listModels();
    const wanted = [...new Set((deps.settings().models ?? []).map((m) => m.trim()).filter(Boolean))];
    const filtered = wanted.filter((m) => configured.includes(m));
    const missing = wanted.filter((m) => !configured.includes(m));
    if (missing.length) log.warn(`anvil.models lists models TrueForge does not have (ignored): ${missing.join(', ')}`);
    if (filtered.length) return filtered;
    const preferred = await preferredChain();
    return [...preferred.filter((m) => configured.includes(m)), ...configured.filter((m) => !preferred.includes(m))];
  }

  async function listAgents(): Promise<WireAgent[]> {
    const out: WireAgent[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = `?limit=50${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
      const r = await requestJson<{ data?: WireAgent[]; pagination?: { next_page_token?: string } }>(baseUrl(), 'GET', `/api/v1/agents${q}`);
      out.push(...(r?.data ?? []));
      token = r?.pagination?.next_page_token;
      if (!token) break;
    }
    return out;
  }

  async function findAgent(name: string): Promise<WireAgent | undefined> {
    return (await listAgents()).find((a) => a.name === name);
  }

  async function loadAgentFiles(): Promise<AgentFile[]> {
    const files = (await fs.readdir(deps.agentsDir)).filter((f) => f.endsWith('.json')).sort();
    const out: AgentFile[] = [];
    for (const f of files) {
      const def = JSON.parse(await fs.readFile(path.join(deps.agentsDir, f), 'utf8'));
      if (def?.name && def?.manifest) out.push(def as AgentFile);
    }
    return out;
  }

  async function ensureSetup(): Promise<void> {
    const url = baseUrl();
    const mcp = deps.mcp();
    await requestJson(url, 'PUT', '/api/v1/settings/mcp-servers', {
      body: {
        manifest: {
          type: 'remote',
          name: mcpServerName,
          url: mcp.url,
          description: MCP_DESCRIPTION,
          auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: mcp.token } },
        },
      },
    });
    log.info(`registered MCP server ${mcpServerName} -> ${mcp.url}`);

    const chain = await modelChain();
    if (!chain.length) {
      throw new Error(
        `No models are configured in TrueForge at ${url}. Run \`npm run setup\` (it reads GEMINI_API_KEY / GROQ_API_KEY / ` +
          `CEREBRAS_API_KEY from your environment or .env and registers the providers), then run "Anvil: Reconnect to TrueForge".`,
      );
    }
    const primary = chain[0];
    const existing = await listAgents();
    for (const def of await loadAgentFiles()) {
      const manifest = specFor(substituteModel(def.manifest, primary), primary);
      const found = existing.find((a) => a.name === def.name);
      if (found) {
        await requestJson(url, 'PUT', `/api/v1/agents/${encodeURIComponent(found.id)}`, { body: { description: def.description, manifest } });
      } else {
        try {
          await requestJson(url, 'POST', '/api/v1/agents', { body: { name: def.name, description: def.description, manifest } });
        } catch (err) {
          if (!(err instanceof TrueForgeHttpError && err.status === 409)) throw err;
          const again = await findAgent(def.name);
          if (!again) throw err;
          await requestJson(url, 'PUT', `/api/v1/agents/${encodeURIComponent(again.id)}`, { body: { description: def.description, manifest } });
        }
      }
      log.info(`upserted agent ${def.name} (model ${primary})`);
    }
  }

  /* ───────────── sessions ───────────── */

  function toSdkSpec(wireSpec: Record<string, any>): any {
    return serialization.AgentSpec.parseOrThrow(wireSpec, {
      unrecognizedObjectKeys: 'passthrough',
      allowUnrecognizedUnionMembers: true,
      allowUnrecognizedEnumValues: true,
      skipValidation: true,
    });
  }

  function specFor(base: Record<string, any>, model: string): Record<string, any> {
    const spec: Record<string, any> = { ...base, model: { ...(base.model ?? {}), name: model } };
    const editorNames = new Set([MCP_SERVER_NAME]);
    if (Array.isArray(base.mcp_servers)) {
      spec.mcp_servers = base.mcp_servers.map((server: { name: string }) => {
        // Another workspace may have updated the shared named agent since setup.
        if (server.name !== MCP_SERVER_NAME && !/^anvil-[a-z0-9-]{1,20}-[a-f0-9]{4}$/.test(server.name)) return server;
        editorNames.add(server.name);
        return { ...server, name: mcpServerName };
      });
    }
    if (typeof base.instructions === 'string') {
      const names = [...editorNames].sort((a, b) => b.length - a.length).join('|');
      spec.instructions = base.instructions.replace(new RegExp(names, 'g'), mcpServerName);
    }
    return spec;
  }

  async function createSession(run: RunState, agent: WireAgent, model: string): Promise<string> {
    const res = await sdk().sessions.create(
      {
        agent: { spec: toSdkSpec(specFor(agent.manifest, model)) },
        metadata: { anvil_agent: agent.name, anvil_kind: run.kind, anvil_run: run.runId },
      },
      { abortSignal: run.abort.signal, maxRetries: 0, timeoutInSeconds: 30 },
    );
    const sid = res.data.id;
    sessionModel.set(sid, model);
    return sid;
  }

  async function patchSessionModel(run: RunState, sid: string, agent: WireAgent, model: string): Promise<void> {
    await sdk().sessions.update(sid, { agent: { spec: toSdkSpec(specFor(agent.manifest, model)) } }, {
      abortSignal: run.abort.signal,
      maxRetries: 0,
      timeoutInSeconds: 30,
    });
    sessionModel.set(sid, model);
  }

  async function currentSessionModel(sid: string): Promise<string | undefined> {
    const known = sessionModel.get(sid);
    if (known) return known;
    try {
      const res = await requestJson<{ data?: { agent?: any } }>(baseUrl(), 'GET', `/api/v1/sessions/${encodeURIComponent(sid)}`);
      const agent = res?.data?.agent;
      const m = agent?.type === 'inline' ? agent?.spec?.model?.name : undefined;
      if (m) sessionModel.set(sid, m);
      return m;
    } catch (err) {
      log.warn(`could not read session ${sid}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async function sessionExists(sid: string): Promise<boolean> {
    try {
      await requestJson(baseUrl(), 'GET', `/api/v1/sessions/${encodeURIComponent(sid)}`);
      return true;
    } catch (err) {
      return !(err instanceof TrueForgeHttpError && (err.status === 404 || err.status === 400));
    }
  }

  async function previousTurnFor(sid: string, fresh: boolean): Promise<string> {
    const known = lastGoodTurn.get(sid);
    if (known) return known;
    if (fresh) return 'none';
    try {
      const res = await requestJson<{ data?: Array<{ id: string; state?: { status?: string } }> }>(
        baseUrl(),
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sid)}/turns?order=desc&limit=50`,
      );
      const good = (res?.data ?? []).find((t) => t?.state?.status === 'done');
      if (good) {
        lastGoodTurn.set(sid, good.id);
        return good.id;
      }
      return 'none';
    } catch (err) {
      log.warn(`could not list turns of ${sid}: ${errorMessage(err)}`);
      return 'auto';
    }
  }

  async function postCancel(sid: string): Promise<void> {
    try {
      await sdk().sessions.cancel(sid, {}, { timeoutInSeconds: 5, maxRetries: 1 });
      log.info(`cancelled session ${sid}`);
    } catch (err) {
      log.warn(`cancel of session ${sid} failed: ${errorMessage(err)}`);
    }
  }

  /* ───────────── runs ───────────── */

  function emit(run: RunState, e: UiEvent): void {
    // Nothing follows run.done (late stream events after a cancel are dropped).
    if (run.finished && e.type !== 'run.done') return;
    if (!run.started && e.type !== 'run.started' && e.type !== 'run.done') {
      run.preStart.push(e);
      return;
    }
    try {
      run.opts.onEvent(e);
    } catch (err) {
      log.warn(`onEvent handler threw: ${errorMessage(err)}`);
    }
  }

  function markStarted(run: RunState, sid: string, model: string): void {
    run.sessionId = sid;
    if (run.finished) return;
    runsBySession.set(sid, run);
    if (run.started) return;
    run.started = true;
    emit(run, { type: 'run.started', runId: run.runId, kind: run.kind, sessionId: sid, model, sessionUrl: sessionUrl(sid), prompt: run.opts.prompt });
    for (const e of run.preStart.splice(0)) emit(run, e);
  }

  function finish(run: RunState, status: RunResult['status'], text: string, error?: string): void {
    if (run.finished) return;
    run.finished = true;
    run.text = text;
    if (run.sessionId && runsBySession.get(run.sessionId) === run) runsBySession.delete(run.sessionId);
    if (!run.started) {
      // Never got a session: still deliver what happened before the failure.
      for (const e of run.preStart.splice(0)) {
        try {
          run.opts.onEvent(e);
        } catch {
          /* ignore */
        }
      }
    }
    const hasUsage = run.usage.inputTokens != null || run.usage.outputTokens != null;
    emit(run, {
      type: 'run.done',
      runId: run.runId,
      status,
      model: run.model,
      text,
      error,
      modelsTried: [...run.modelsTried],
      usage: hasUsage ? { ...run.usage } : undefined,
      elapsedMs: Date.now() - run.startedAt,
    });
    run.resolveDone({ status, text, model: run.model, sessionId: run.sessionId, error, modelsTried: [...run.modelsTried] });
    log.info(`run ${run.runId} ${status}${error ? `: ${shortError(error)}` : ''}`);
  }

  function addUsage(run: RunState, tr: TurnTranslator): void {
    const u = tr.usage;
    if (u.inputTokens != null) run.usage.inputTokens = (run.usage.inputTokens ?? 0) + u.inputTokens;
    if (u.outputTokens != null) run.usage.outputTokens = (run.usage.outputTokens ?? 0) + u.outputTokens;
    if (u.cacheReadTokens != null) run.usage.cacheReadTokens = (run.usage.cacheReadTokens ?? 0) + u.cacheReadTokens;
  }

  function sleep(run: RunState, ms: number): Promise<void> {
    return Promise.race([new Promise<void>((r) => setTimeout(r, ms)), run.cancelSignal]);
  }

  function approvalKind(name: string): 'edit' | 'command' | 'other' {
    if (EDIT_TOOLS.includes(name)) return 'edit';
    if (name === TOOL_NAMES.runCommand) return 'command';
    return 'other';
  }

  /** Fallback when the referenced model.message was not seen on this stream (e.g. after a re-subscribe). */
  async function lookupCall(sid: string, turnId: string, ref: ApprovalRef): Promise<ToolCallInfo | undefined> {
    try {
      const res = await requestJson<{ data?: any[] }>(
        baseUrl(),
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turnId)}/events?order=asc&limit=500`,
      );
      for (const item of res?.data ?? []) {
        const ev = item?.event ?? item;
        if (ev?.type !== 'model.message') continue;
        const tc = (ev.tool_calls ?? []).find((t: any) => t?.id === ref.callId);
        if (!tc) continue;
        const info = tc.tool_info ?? {};
        return toToolCallInfo(
          { id: tc.id, function: tc.function, toolInfo: { type: info.type, name: info.name, serverName: info.server_name } },
          ref.threadId ?? ev.thread_id ?? null,
        );
      }
    } catch (err) {
      log.warn(`could not look up tool call ${ref.callId}: ${errorMessage(err)}`);
    }
    return undefined;
  }

  async function handleApproval(run: RunState, sid: string, turnId: string, tr: TurnTranslator, ref: ApprovalRef, editedPaths: Set<string>): Promise<void> {
    if (run.cancelled || run.finished) return;
    const info = tr.resolveCall(ref) ?? (await lookupCall(sid, turnId, ref));
    let decision: ApprovalDecision;
    if (!info) {
      decision = { status: 'deny', reason: 'Anvil could not find this tool call to show it for review. Try the call again.' };
      log.warn(`approval for unknown call ${ref.callId}; denying`);
    } else if (deferUntilToolResults(info, editedPaths)) {
      decision = { status: 'deny', reason: 'Issue this call again after the previous tool results arrive.' };
    } else {
      tr.setCallStatus(ref.callId, 'awaiting-approval', info);
      emit(run, { type: 'approval.requested', runId: run.runId, call: info, kind: approvalKind(info.name) });
      run.pendingApprovals.add(ref.callId);
      try {
        decision = await Promise.race([
          Promise.resolve(run.opts.onApproval(info, run.runId)),
          run.cancelSignal.then((): ApprovalDecision => ({ status: 'deny', reason: 'Run cancelled by the user.' })),
        ]);
      } catch (err) {
        decision = { status: 'deny', reason: `Approval failed: ${errorMessage(err)}` };
      }
      if (!run.pendingApprovals.delete(ref.callId)) return; // already resolved by cancel()
      if (!decision || (decision.status !== 'allow' && decision.status !== 'deny')) decision = { status: 'deny', reason: 'Invalid approval decision.' };
    }
    if (run.cancelled || run.finished || tr.outcome) return;
    if (decision.status === 'allow' && info && APPROVAL_TOOLS.includes(info.name)) tr.hadSideEffects = true;
    try {
      await sdk().sessions.createTurnEvents(
        sid,
        turnId,
        {
          events: [
            {
              type: 'user.tool_approval',
              threadId: ref.threadId ?? 'main',
              toolCallId: ref.callId,
              approval: decision.status === 'allow' ? { status: 'allow' } : { status: 'deny', reason: decision.reason },
            } as any,
          ],
        },
        { maxRetries: 1, timeoutInSeconds: 30 },
      );
    } catch (err) {
      log.warn(`posting approval for ${ref.callId} failed: ${errorMessage(err)}`);
    }
    emit(run, {
      type: 'approval.resolved',
      runId: run.runId,
      callId: ref.callId,
      decision: decision.status,
      reason: decision.status === 'deny' ? decision.reason : undefined,
    });
    if (info) tr.setCallStatus(ref.callId, decision.status === 'allow' ? 'running' : 'denied', info);
  }

  function deferUntilToolResults(call: ToolCallInfo, editedPaths: Set<string>): boolean {
    if (call.name === TOOL_NAMES.runCommand) return editedPaths.size > 0;
    if (!EDIT_TOOLS.includes(call.name)) return false;
    const raw = String(call.args.path ?? '');
    let relPath = raw;
    try {
      relPath = deps.resolvePath?.(raw) ?? path.normalize(raw.trim().replace(/^["']|["']$/g, ''));
    } catch {
      // Leave invalid paths to the regular approval handler.
    }
    if (editedPaths.has(relPath)) return true;
    editedPaths.add(relPath);
    return false;
  }

  function enqueueApprovals(run: RunState, sid: string, tr: TurnTranslator, refs: ApprovalRef[]): void {
    const turnId = tr.turnId;
    if (!turnId) {
      log.warn('approval requested before turn.created; ignoring');
      return;
    }
    run.approvalChain = run.approvalChain
      .then(async () => {
        const editedPaths = new Set<string>();
        for (const ref of refs) {
          if (run.cancelled || run.finished || tr.outcome) return;
          await handleApproval(run, sid, turnId, tr, ref, editedPaths);
        }
      })
      .catch((err) => log.error(`approval handling failed: ${errorMessage(err)}`));
  }

  async function consume(run: RunState, sid: string, tr: TurnTranslator, stream: AsyncIterable<unknown>): Promise<number> {
    let count = 0;
    try {
      for await (const ev of stream) {
        if (run.cancelled) break;
        count++;
        const refs = tr.handle(ev as Record<string, any>);
        if (refs) enqueueApprovals(run, sid, tr, refs);
        if (tr.outcome) break;
      }
    } catch (err) {
      if (!run.cancelled) log.warn(`turn stream interrupted: ${errorMessage(err)}`);
    }
    return count;
  }

  async function runTurn(run: RunState, sid: string, previousTurnId: string, prompt: string): Promise<TurnResult> {
    const tr = new TurnTranslator(run.runId, (e) => emit(run, e));
    run.current = tr;
    const reqOpts = { abortSignal: run.abort.signal, maxRetries: 0, timeoutInSeconds: 3600 };
    let stream: AsyncIterable<unknown>;
    run.turnInFlight = true;
    try {
      stream = await sdk().sessions.createTurnStream(
        sid,
        { input: [{ type: 'user.message', content: prompt } as any], previousTurnId },
        reqOpts,
      );
    } catch (err) {
      run.turnInFlight = false;
      if (run.cancelled) return { status: 'cancelled', text: '' };
      if (isConnectionError(err)) return { status: 'error', text: '', fatal: true, error: new TrueForgeUnreachableError(baseUrl(), err).message };
      const status = (err as { statusCode?: number }).statusCode;
      const msg = apiErrorMessage((err as { body?: unknown }).body) ?? errorMessage(err);
      return { status: 'error', text: '', fatal: true, error: `TrueForge rejected the turn${status ? ` (${status})` : ''}: ${msg}` };
    }
    run.turnInFlight = false;
    if (run.cancelled) {
      void postCancel(sid);
      return { status: 'cancelled', text: '' };
    }

    await consume(run, sid, tr, stream);
    let recoveryFailures = 0;
    while (!tr.outcome && !run.cancelled) {
      if (!tr.turnId) return { status: 'error', text: '', fatal: true, error: 'The TrueForge stream ended before the turn was created.' };
      let recoveryError: string | undefined;
      try {
        const res = await sdk().sessions.getTurn(sid, tr.turnId, { abortSignal: run.abort.signal, maxRetries: 0, timeoutInSeconds: 30 });
        const state = res.data.state;
        if (state?.status !== 'running' && state?.status !== 'paused') {
          tr.outcome = tr.outcomeFromState(state);
          break;
        }
        log.info(`turn ${tr.turnId} still ${state.status}; re-subscribing after ${tr.lastEventId ?? 'start'}`);
        const sub = await sdk().sessions.subscribeToTurn(sid, tr.turnId, tr.lastEventId ? { afterEventId: tr.lastEventId } : {}, reqOpts);
        const n = await consume(run, sid, tr, sub);
        if (n > 0) {
          recoveryFailures = 0;
          continue;
        }
      } catch (err) {
        if (run.cancelled) break;
        if ((err as { statusCode?: number }).statusCode === 404) {
          return { status: 'error', text: tr.partialText, fatal: true, error: 'TrueForge session no longer exists' };
        }
        recoveryError = errorMessage(err);
        log.warn(`could not recover turn ${tr.turnId}: ${recoveryError}`);
      }
      if (++recoveryFailures >= 10) {
        return {
          status: 'error', text: tr.partialText, fatal: true,
          error: `Could not recover the TrueForge stream after 10 attempts${recoveryError ? `: ${recoveryError}` : '.'}`,
        };
      }
      await sleep(run, recoveryError ? 1000 : Math.min(5000, 250 * 2 ** Math.min(recoveryFailures - 1, 4)));
    }
    addUsage(run, tr);
    if (run.cancelled) return { status: 'cancelled', text: tr.outcome?.text ?? '', turnId: tr.turnId };
    const out = tr.outcome!;
    return { ...out, turnId: tr.turnId, progressed: tr.progressed, hadSideEffects: tr.hadSideEffects };
  }

  async function execute(run: RunState): Promise<void> {
    const settings = deps.settings();
    const maxAttempts = Math.max(1, Math.min(10, Math.floor(settings.retryMaxAttempts || 1)));
    let chain: string[];
    try {
      chain = await modelChain();
    } catch (err) {
      return finish(run, 'error', '', errorMessage(err));
    }
    if (!chain.length) {
      return finish(run, 'error', '', `No models are configured in TrueForge at ${baseUrl()}. Run \`npm run setup\` to register a model provider.`);
    }
    run.model = chain[0];
    const agentName = run.kind === 'agent' ? settings.coderAgent : settings.inlineAgent;
    let agent: WireAgent | undefined;
    try {
      agent = await findAgent(agentName);
      if (!agent) {
        log.warn(`agent ${agentName} not registered; running setup`);
        await ensureSetup().catch((err) => log.warn(`setup failed: ${errorMessage(err)}`));
        agent = await findAgent(agentName);
      }
    } catch (err) {
      return finish(run, 'error', '', errorMessage(err));
    }
    if (!agent) {
      return finish(run, 'error', '', `Agent "${agentName}" is not registered in TrueForge. Run \`npm run setup\` or "Anvil: Reconnect to TrueForge".`);
    }
    if (run.cancelled) return;

    let sid = run.kind === 'agent' ? run.opts.sessionId : undefined;
    if (sid && !(await sessionExists(sid))) {
      log.warn(`session ${sid} no longer exists in TrueForge; starting a new one`);
      sid = undefined;
    }
    const reused = !!sid;
    let order = chain;
    if (sid) {
      const current = await currentSessionModel(sid);
      // Stay on the model that last worked in this session; the others remain fallbacks.
      if (current && chain.includes(current)) order = [current, ...chain.filter((m) => m !== current)];
    }

    const failures: Array<{ model: string; error: string }> = [];
    let toolsRanBeforeFailure = false;
    let continuation: { turnId: string; prompt: string } | undefined;
    for (let mi = 0; mi < order.length; mi++) {
      if (run.cancelled) return;
      const model = order[mi];
      const next = order[mi + 1];
      run.model = model;
      if (!run.modelsTried.includes(model)) run.modelsTried.push(model);

      // 1) Make sure the session exists and runs on `model`.
      try {
        if (!sid) {
          sid = await createSession(run, agent, model);
          run.sessionId = sid;
          if (run.cancelled) {
            await postCancel(sid);
            return;
          }
          markStarted(run, sid, model);
        } else {
          if ((await currentSessionModel(sid)) !== model) await patchSessionModel(run, sid, agent, model);
          markStarted(run, sid, model);
        }
      } catch (err) {
        if (run.cancelled) return;
        if (isConnectionError(err)) return finish(run, 'error', '', new TrueForgeUnreachableError(baseUrl(), err).message);
        const msg = apiErrorMessage((err as { body?: unknown }).body) ?? errorMessage(err);
        failures.push({ model, error: msg });
        log.warn(`session setup on ${model} failed: ${msg}`);
        if (next) emit(run, { type: 'model.fallback', runId: run.runId, from: model, to: next, error: shortError(msg) });
        continue;
      }

      // 2) Send the turn; retry transient failures with visible backoff.
      let lastError = '';
      for (let attempt = 1; ; attempt++) {
        if (run.cancelled) return;
        const prev = continuation?.turnId ?? await previousTurnFor(sid, !reused && !lastGoodTurn.has(sid));
        const res = await runTurn(run, sid, prev, continuation?.prompt ?? run.opts.prompt);
        if (run.cancelled) return;
        if (res.status === 'done') {
          if (res.turnId) lastGoodTurn.set(sid, res.turnId);
          return finish(run, 'done', res.text);
        }
        if (res.status === 'cancelled') {
          // Cancelled server-side (e.g. a newer turn in the same session, or a timeout).
          return finish(run, 'cancelled', res.text, res.reason ? `Turn cancelled (${res.reason}).` : undefined);
        }
        const error = res.error ?? 'unknown error';
        if (res.progressed || res.hadSideEffects) toolsRanBeforeFailure = true;
        if (res.fatal) return finish(run, 'error', res.text, error);
        const cls = classifyError(error);
        log.warn(`turn on ${model} failed (${cls}, attempt ${attempt}/${maxAttempts}): ${shortError(error, 400)}`);
        if (cls === 'other') return finish(run, 'error', res.text, error);
        if (res.hadSideEffects && res.turnId) {
          continuation = {
            turnId: res.turnId,
            prompt: `The previous attempt stopped because the model call failed (${shortError(error)}). Continue the same task from where it stopped. The edits and commands above already happened - do not repeat them.`,
          };
        }
        lastError = error;
        const attemptsHere = isRateLimited(error) ? Math.max(maxAttempts, 5) : maxAttempts;
        if (cls === 'transient' && attempt < attemptsHere) {
          const delayMs = retryDelayMs(error, attempt, backoffBase);
          emit(run, { type: 'model.retry', runId: run.runId, model, attempt: attempt + 1, maxAttempts: attemptsHere, delayMs, error: shortError(error) });
          await sleep(run, delayMs);
          continue;
        }
        break;
      }
      failures.push({ model, error: lastError });
      if (next) emit(run, { type: 'model.fallback', runId: run.runId, from: model, to: next, error: shortError(lastError) });
    }

    const summary = failures.map((f) => `- ${f.model}: ${shortError(f.error, 300)}`).join('\n');
    finish(
      run,
      'error',
      '',
      `All ${order.length} configured model${order.length === 1 ? '' : 's'} failed` +
        (toolsRanBeforeFailure
          ? '; some tool calls completed before the failure (any applied edit was reviewed and is listed in Changes).'
          : '; no files were changed by the failed attempts.') +
        `\n${summary}`,
    );
  }

  function startRun(opts: StartRunOptions): RunHandle {
    let resolveDone!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => (resolveDone = r));
    let fireCancel!: () => void;
    const cancelSignal = new Promise<void>((r) => (fireCancel = r));
    const run: RunState = {
      runId: randomUUID(),
      kind: opts.kind,
      opts,
      startedAt: Date.now(),
      abort: new AbortController(),
      cancelled: false,
      finished: false,
      started: false,
      model: '',
      modelsTried: [],
      text: '',
      usage: {},
      approvalChain: Promise.resolve(),
      pendingApprovals: new Set(),
      preStart: [],
      turnInFlight: false,
      cancelSignal,
      fireCancel,
      resolveDone,
    };
    log.info(`run ${run.runId} (${opts.kind}) starting${opts.sessionId ? ` in session ${opts.sessionId}` : ''}`);

    void execute(run).catch((err) => {
      log.error(`run ${run.runId} crashed`, err);
      finish(run, run.cancelled ? 'cancelled' : 'error', run.text, run.cancelled ? undefined : errorMessage(err));
    });

    const handle: RunHandle = {
      runId: run.runId,
      kind: run.kind,
      get sessionId() {
        return run.sessionId;
      },
      done,
      cancel: async () => {
        try {
          if (run.finished || run.cancelled) return;
          run.cancelled = true;
          run.fireCancel();
          for (const callId of run.pendingApprovals) {
            emit(run, { type: 'approval.resolved', runId: run.runId, callId, decision: 'deny', reason: 'Run cancelled by the user.' });
          }
          run.pendingApprovals.clear();
          const inFlight = run.turnInFlight;
          finish(run, 'cancelled', run.current?.partialText ?? run.text);
          run.abort.abort();
          const sid = run.sessionId;
          if (sid) {
            await postCancel(sid);
            // A turn request that was still in flight may be created after our first cancel.
            if (inFlight) {
              setTimeout(() => void postCancel(sid), 400);
              setTimeout(() => void postCancel(sid), 1500);
            }
          }
          // No session yet: execute() cancels it as soon as it exists.
        } catch (err) {
          log.warn(`cancel failed: ${errorMessage(err)}`);
        }
      },
    };
    return handle;
  }

  function runForSession(sessionId: string | undefined): { runId: string; kind: RunKind } | undefined {
    if (!sessionId) return undefined;
    const run = runsBySession.get(sessionId);
    return run && !run.finished ? { runId: run.runId, kind: run.kind } : undefined;
  }

  function sessionUrl(sessionId: string): string {
    return `${baseUrl()}/sessions/${sessionId}`;
  }

  return {
    get baseUrl() {
      return baseUrl();
    },
    health,
    ensureSetup,
    listModels,
    modelChain,
    startRun,
    runForSession,
    sessionUrl,
  };
}

/** Deep-replaces the `${PRIMARY_MODEL}` placeholder and forces model.name to `model`. */
export function substituteModel(manifest: Record<string, any>, model: string): Record<string, any> {
  const replaced = JSON.parse(JSON.stringify(manifest).split(PRIMARY_PLACEHOLDER).join(model));
  replaced.model = { ...(replaced.model ?? {}), name: model };
  return replaced;
}
