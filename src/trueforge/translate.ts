/**
 * Translates TrueForge turn stream events (SDK camelCase shapes) into Anvil UiEvents.
 *
 * One translator per turn. It merges `model.message.delta` into the base
 * `model.message`, emits only the new text/reasoning suffix per message, tracks tool
 * calls from the first streamed fragment to their `tool.response`, and reports
 * `tool.approval_required` references back to the caller.
 */
import { isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import type { ToolCallInfo, UiEvent, UsageInfo } from '../shared/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ev = Record<string, any>;

export interface ApprovalRef {
  callId: string;
  sourceEventId: string;
  threadId: string | null;
}

export interface TurnOutcome {
  status: 'done' | 'cancelled' | 'error';
  error?: string;
  reason?: string;
  text: string;
}

interface CallState {
  callId: string;
  threadId: string | null;
  rawName: string;
  name: string;
  server?: string;
  status: 'streaming' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied';
  args?: Record<string, unknown>;
  argsLen: number;
  lastEmitLen: number;
  lastEmitAt: number;
}

const DEFERRED_CALL_TOOL = 'call_tool';
const SUMMARY_MAX = 300;

export class TurnTranslator {
  turnId?: string;
  lastEventId?: string;
  outcome?: TurnOutcome;
  /** True once any tool produced a result in this turn (the turn made progress). */
  progressed = false;
  readonly usage: UsageInfo = {};

  private readonly messages = new Map<string, Ev>();
  private readonly emittedText = new Map<string, number>();
  private readonly emittedReasoning = new Map<string, number>();
  private readonly calls = new Map<string, CallState>();
  private readonly usageCounted = new Set<string>();
  private lastMainText = '';

  /** Latest main-thread assistant text seen so far (partial while streaming). */
  get partialText(): string {
    return this.lastMainText;
  }

  constructor(
    private readonly runId: string,
    private readonly emit: (e: UiEvent) => void,
  ) {}

  /** Processes one stream event. Returns approval references when TrueForge paused for approval. */
  handle(ev: Ev): ApprovalRef[] | undefined {
    if (!ev || typeof ev !== 'object') return undefined;
    if (typeof ev.id === 'string' && ev.type !== 'model.message.delta') this.lastEventId = ev.id;
    // Deltas share the id of their base message; they still count as "seen" stream positions,
    // but TrueForge's after_event_id expects persisted event ids, which deltas are not.

    if (isEventDelta(ev as { type: string })) {
      const base = this.messages.get(ev.id);
      if (base) {
        mergeEventDelta(base as any, ev as any);
        this.progress(base);
      }
      return undefined;
    }

    switch (ev.type) {
      case 'turn.created':
        this.turnId = ev.turnId ?? this.turnId;
        return undefined;
      case 'model.message': {
        const prev = this.messages.get(ev.id);
        // A later snapshot of the same message (e.g. after re-subscribing) replaces the base.
        const base = prev && textOf(prev.content).length > textOf(ev.content).length ? prev : cloneMessage(ev);
        this.messages.set(ev.id, base);
        this.progress(base);
        return undefined;
      }
      case 'tool.approval_required': {
        const refs: ApprovalRef[] = [];
        for (const ref of ev.toolCalls ?? []) {
          if (!ref?.id) continue;
          refs.push({ callId: ref.id, sourceEventId: ref.sourceEventId, threadId: ev.threadId ?? null });
        }
        return refs.length ? refs : undefined;
      }
      case 'tool.response':
        this.onToolResponse(ev);
        return undefined;
      case 'thread.created':
        if (ev.threadId) {
          this.emit({
            type: 'subagent.started',
            runId: this.runId,
            threadId: ev.threadId,
            name: ev.agentInfo?.name ?? ev.title ?? 'sub-agent',
            input: stringify(ev.agentInfo?.input ?? ''),
          });
        }
        return undefined;
      case 'thread.done':
        if (ev.threadId) {
          const st = ev.state ?? {};
          const ok = st.status === 'done';
          this.emit({
            type: 'subagent.done',
            runId: this.runId,
            threadId: ev.threadId,
            ok,
            output: stringify(ok ? st.output ?? '' : st.error ?? st.output ?? 'sub-agent failed'),
          });
        }
        return undefined;
      case 'thread.context_compaction_started':
      case 'thread.context_compaction_finished':
        this.emit({
          type: 'compaction',
          runId: this.runId,
          threadId: ev.threadId ?? null,
          phase: ev.type.endsWith('started') ? 'started' : 'finished',
          contextTokens: ev.trigger?.contextTokens,
          thresholdTokens: ev.trigger?.thresholdTokens,
          durationMs: ev.durationMs,
        });
        return undefined;
      case 'turn.done':
        this.outcome = this.outcomeFromState(ev.state);
        return undefined;
      default:
        return undefined;
    }
  }

  /** Outcome derived from a turn state (turn.done event or GET /turns/{id}). */
  outcomeFromState(state: Ev | undefined): TurnOutcome {
    const st = state ?? {};
    if (st.status === 'done') {
      const out = textOf(st.output?.content);
      return { status: 'done', text: out || this.lastMainText };
    }
    if (st.status === 'cancelled') return { status: 'cancelled', reason: st.reason, text: this.lastMainText };
    if (st.status === 'error') return { status: 'error', error: String(st.message ?? 'unknown error'), text: this.lastMainText };
    return { status: 'error', error: `unexpected turn state ${JSON.stringify(st).slice(0, 200)}`, text: this.lastMainText };
  }

  /** Resolves an approval reference to the real tool name/args using the merged model messages. */
  resolveCall(ref: ApprovalRef, messageOverride?: Ev): ToolCallInfo | undefined {
    const msg = messageOverride ?? this.messages.get(ref.sourceEventId) ?? this.findMessageWithCall(ref.callId);
    const tc = (msg?.toolCalls as Ev[] | undefined)?.find((t) => t?.id === ref.callId);
    if (!tc) return undefined;
    return toToolCallInfo(tc, ref.threadId ?? msg?.threadId ?? null);
  }

  /** Marks a call's status and emits a tool.call update. */
  setCallStatus(callId: string, status: CallState['status'], info?: ToolCallInfo): void {
    let st = this.calls.get(callId);
    if (!st && info) {
      st = { callId, threadId: info.threadId, rawName: info.name, name: info.name, server: info.server, status, args: info.args, argsLen: 0, lastEmitLen: 0, lastEmitAt: 0 };
      this.calls.set(callId, st);
    }
    if (!st) return;
    st.status = status;
    if (info) {
      st.name = info.name;
      st.server = info.server ?? st.server;
      st.args = info.args;
    }
    this.emitCall(st);
  }

  private findMessageWithCall(callId: string): Ev | undefined {
    for (const m of this.messages.values()) if ((m.toolCalls as Ev[] | undefined)?.some((t) => t?.id === callId)) return m;
    return undefined;
  }

  private progress(msg: Ev): void {
    const threadId: string | null = msg.threadId ?? null;
    const text = textOf(msg.content);
    const sentText = this.emittedText.get(msg.id) ?? 0;
    if (text.length > sentText) {
      this.emit({ type: 'text.delta', runId: this.runId, threadId, messageId: msg.id, text: text.slice(sentText) });
      this.emittedText.set(msg.id, text.length);
    }
    if (isMainThread(threadId) && text) this.lastMainText = text;

    const reasoning = typeof msg.reasoningContent === 'string' ? msg.reasoningContent : '';
    const sentReasoning = this.emittedReasoning.get(msg.id) ?? 0;
    if (reasoning.length > sentReasoning) {
      this.emit({ type: 'reasoning.delta', runId: this.runId, threadId, messageId: msg.id, text: reasoning.slice(sentReasoning) });
      this.emittedReasoning.set(msg.id, reasoning.length);
    }

    const finished = msg.finishReason != null;
    for (const tc of (msg.toolCalls as Ev[] | undefined) ?? []) {
      if (!tc?.id) continue;
      const rawArgs: string = tc.function?.arguments ?? '';
      let st = this.calls.get(tc.id);
      const display = displayName(tc);
      if (!st) {
        st = {
          callId: tc.id,
          threadId,
          rawName: tc.function?.name ?? '',
          name: display.name,
          server: display.server,
          status: 'streaming',
          argsLen: rawArgs.length,
          lastEmitLen: -1,
          lastEmitAt: 0,
        };
        this.calls.set(tc.id, st);
      }
      st.argsLen = rawArgs.length;
      if (display.name !== st.name && st.status === 'streaming') {
        st.name = display.name;
        st.server = display.server ?? st.server;
      }
      if (st.status === 'streaming') {
        if (finished) {
          const info = toToolCallInfo(tc, threadId);
          st.name = info.name;
          st.server = info.server;
          st.args = info.args;
          st.status = 'running';
          this.emitCall(st);
        } else {
          const now = Date.now();
          if (st.lastEmitLen < 0 || st.argsLen - st.lastEmitLen >= 256 || now - st.lastEmitAt >= 150) this.emitCall(st);
        }
      }
    }

    if (finished && msg.usage && !this.usageCounted.has(msg.id)) {
      this.usageCounted.add(msg.id);
      this.usage.inputTokens = (this.usage.inputTokens ?? 0) + (msg.usage.inputTokens ?? 0);
      this.usage.outputTokens = (this.usage.outputTokens ?? 0) + (msg.usage.outputTokens ?? 0);
      if (msg.usage.cacheReadTokens != null) this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + msg.usage.cacheReadTokens;
    }
  }

  private emitCall(st: CallState): void {
    st.lastEmitLen = st.argsLen;
    st.lastEmitAt = Date.now();
    this.emit({
      type: 'tool.call',
      runId: this.runId,
      threadId: st.threadId,
      callId: st.callId,
      name: st.name,
      server: st.server,
      args: st.status === 'streaming' ? undefined : st.args,
      argsChars: st.argsLen,
      status: st.status,
    });
  }

  private onToolResponse(ev: Ev): void {
    const callId: string = ev.toolCallId;
    const st = this.calls.get(callId);
    const name = st?.name ?? 'tool';
    const { ok, denied, summary } = summarizeToolContent(ev.content);
    if (ok) this.progressed = true;
    if (st) {
      st.status = denied ? 'denied' : ok ? 'done' : 'error';
      this.emitCall(st);
    }
    this.emit({ type: 'tool.result', runId: this.runId, threadId: ev.threadId ?? st?.threadId ?? null, callId, name, ok, summary });
  }
}

/* ───────────────────────── helpers ───────────────────────── */

export function isMainThread(threadId: string | null | undefined): boolean {
  return threadId == null || threadId === 'main';
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as Ev).text === 'string' ? (p as Ev).text : ''))
      .join('');
  }
  return '';
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  const t = textOf(v);
  if (t) return t;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function cloneMessage(ev: Ev): Ev {
  const copy: Ev = { ...ev };
  if (Array.isArray(ev.toolCalls)) copy.toolCalls = ev.toolCalls.map((t: Ev) => ({ ...t, function: { ...(t.function ?? {}) } }));
  return copy;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return undefined;
  }
}

/** Name to show while a call is still streaming (peeks into partial `call_tool` args). */
function displayName(tc: Ev): { name: string; server?: string } {
  const raw: string = tc.function?.name ?? '';
  const info = tc.toolInfo ?? {};
  if (raw === DEFERRED_CALL_TOOL) {
    const args: string = tc.function?.arguments ?? '';
    const m = /"tool_name"\s*:\s*"([^"]+)"/.exec(args);
    const s = /"mcp_server"\s*:\s*"([^"]+)"/.exec(args);
    if (m) return { name: m[1], server: s?.[1] };
    return { name: raw };
  }
  return { name: info.type === 'mcp' && info.name ? info.name : raw, server: info.type === 'mcp' ? info.serverName : undefined };
}

/** Builds a ToolCallInfo, unwrapping TrueForge's deferred `call_tool{mcp_server, tool_name, input}`. */
export function toToolCallInfo(tc: Ev, threadId: string | null): ToolCallInfo {
  const raw: string = tc.function?.name ?? '';
  const info = tc.toolInfo ?? {};
  const args: Record<string, unknown> = parseArgs(tc.function?.arguments) ?? { _raw: tc.function?.arguments ?? '' };
  if (raw === DEFERRED_CALL_TOOL && typeof args.tool_name === 'string') {
    const input = args.input ?? args.arguments ?? {};
    return {
      callId: tc.id,
      threadId,
      name: args.tool_name,
      server: typeof args.mcp_server === 'string' ? args.mcp_server : undefined,
      args: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input },
    };
  }
  return {
    callId: tc.id,
    threadId,
    name: info.type === 'mcp' && info.name ? info.name : raw,
    server: info.type === 'mcp' ? info.serverName : undefined,
    args,
  };
}

/** Summarises a tool.response payload to <= 300 chars and detects `{"error": …}` payloads. */
export function summarizeToolContent(content: unknown): { ok: boolean; denied: boolean; summary: string } {
  const raw = typeof content === 'string' ? content : stringify(content);
  let ok = true;
  let text = raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Ev;
    if (!Array.isArray(p) && 'error' in p) {
      ok = false;
      text = flattenError(p.error);
    } else if (Array.isArray(p)) {
      text = textOf(p) || raw;
    } else if (Array.isArray(p.content)) {
      text = textOf(p.content) || raw;
      if (p.isError === true) ok = false;
    }
  }
  const denied = !ok && /user denied tool call/i.test(text);
  if (denied) text = text.replace(/^.*?user denied tool call:\s*/i, 'Denied: ').replace(/"?\}?\s*$/, '');
  return { ok, denied, summary: clip(text.replace(/\s+/g, ' ').trim(), SUMMARY_MAX) };
}

function flattenError(err: unknown): string {
  if (typeof err === 'string') {
    try {
      const inner = JSON.parse(err);
      if (inner && typeof inner === 'object' && 'error' in inner) return flattenError((inner as Ev).error);
    } catch {
      /* plain string */
    }
    return err;
  }
  if (Array.isArray(err)) return err.map((e) => flattenError(typeof e === 'object' && e && 'text' in e ? (e as Ev).text : e)).join(' ');
  if (err && typeof err === 'object') return flattenError((err as Ev).message ?? (err as Ev).text ?? JSON.stringify(err));
  return String(err);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
