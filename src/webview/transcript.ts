import type { AppliedChangeSummary, ToolCallInfo, UiEvent } from '../shared/contracts';
import {
  button, chip, compactCount, contextCard, count, disclosure, duration, element, fileLink,
  paintChip, post, renderMarkdown,
} from './render';

type Delta = Extract<UiEvent, { type: 'text.delta' | 'reasoning.delta' }>;
type ApprovalRequest = Extract<UiEvent, { type: 'approval.requested' }>;
type ApprovalResult = Extract<UiEvent, { type: 'approval.resolved' }>;
type ToolStatus = Extract<UiEvent, { type: 'tool.call' }>['status'];
type Decision = 'allow' | 'allow-session' | 'deny';

interface TextBlock {
  body: HTMLElement;
  source: string;
  markdown: boolean;
}

interface Thread {
  body: HTMLElement;
  messages: Map<string, TextBlock>;
}

interface Subagent extends Thread {
  section: HTMLDetailsElement;
  label: HTMLElement;
  status: HTMLElement;
  output: HTMLElement;
}

interface ToolRow {
  name: HTMLElement;
  args: HTMLElement;
  status: HTMLElement;
  result: HTMLElement;
  row: HTMLDetailsElement;
  summary: HTMLElement;
  currentStatus: ToolStatus;
}

interface ApprovalCard {
  status: HTMLElement;
  reason: HTMLElement;
  actions: HTMLElement;
}

interface ChangeRow {
  row: HTMLElement;
  path: HTMLButtonElement;
  added: HTMLElement;
  removed: HTMLElement;
  hunks: HTMLElement;
  undo: HTMLButtonElement;
  state: HTMLElement;
  undone: boolean;
}

interface Run {
  section: HTMLElement;
  prompt: HTMLElement;
  main: Thread;
  hasMainText: boolean;
  subagents: Map<string, Subagent>;
  tools: Map<string, ToolRow>;
  approvals: Map<string, ApprovalCard>;
  approvalResults: Map<string, ApprovalResult>;
  compactions: Map<string, { contextTokens?: number; thresholdTokens?: number }>;
  changesSection: HTMLElement;
  changesList: HTMLElement;
  changes: Map<string, ChangeRow>;
  undone: Set<string>;
  undoAll: HTMLButtonElement;
  noChanges: HTMLElement;
  footer: HTMLElement;
}

const TOOL_STATUS: Record<ToolStatus, [string, string]> = {
  streaming: ['Streaming', 'accent'],
  'awaiting-approval': ['Awaiting approval', 'warning'],
  running: ['Running', 'accent'],
  done: ['Done', 'success'],
  error: ['Error', 'error'],
  denied: ['Denied', 'error'],
};

function argText(args: ToolCallInfo['args'] | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function upsertTool(run: Run, thread: Thread, callId: string, name: string, server?: string): ToolRow {
  const existing = run.tools.get(callId);
  if (existing) return existing;

  const row = element('details', 'tool');
  const summary = element('summary', 'tool-summary');
  const nameText = element('span', 'tool-name mono', name);
  if (server) nameText.title = `${server} · ${name}`;
  const args = element('span', 'tool-args mono');
  const status = chip('Streaming', 'accent');
  const result = element('pre', 'tool-result mono');
  const labels = element('span', 'tool-labels');
  labels.append(nameText, args);
  summary.append(labels, status);
  summary.tabIndex = -1;
  summary.addEventListener('click', event => {
    if (!row.classList.contains('has-result')) event.preventDefault();
  });
  row.append(summary, result);
  thread.body.append(row);

  const tool: ToolRow = { name: nameText, args, status, result, row, summary, currentStatus: 'streaming' };
  run.tools.set(callId, tool);
  return tool;
}

function setToolStatus(tool: ToolRow, status: ToolStatus): void {
  tool.currentStatus = status;
  tool.row.dataset.status = status;
  paintChip(tool.status, ...TOOL_STATUS[status]);
}

function subagentFor(run: Run, threadId: string): Subagent {
  const existing = run.subagents.get(threadId);
  if (existing) return existing;

  const section = element('details', 'subagent');
  section.open = true;
  const header = element('summary', 'subagent-header');
  const label = element('h3', '', `Sub-agent: ${threadId}`);
  const status = chip('Running', 'accent');
  header.append(label, status);
  const body = element('div', 'timeline');
  const output = element('div', 'subagent-output');
  output.hidden = true;
  section.append(header, body, output);
  run.main.body.append(section);

  const subagent = { section, label, status, body, messages: new Map<string, TextBlock>(), output };
  run.subagents.set(threadId, subagent);
  return subagent;
}

function threadFor(run: Run, threadId: string | null): Thread {
  return threadId && threadId !== 'main' ? subagentFor(run, threadId) : run.main;
}

function scoutOutput(thread: Subagent, ok: boolean, output: string): void {
  paintChip(thread.status, ok ? 'Done' : 'Error', ok ? 'success' : 'error');
  thread.section.open = !ok;
  if (!output.trim()) return;
  const list = element('ul', 'scout-list');
  for (const line of output.trim().split(/\r?\n/)) {
    const entry = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    if (!entry) continue;
    const row = element('li');
    const file = /^`?(.+?):(\d+)(?:[-–](\d+))?`?\s+[-–—]\s+(.+)$/.exec(entry);
    if (file) {
      const [, path, start, end, reason] = file;
      row.append(fileLink(path, Number(start)), element('span', 'span-range mono', `L${start}${end ? `–${end}` : ''}`),
        element('div', 'muted', reason));
    } else {
      row.textContent = entry;
    }
    list.append(row);
  }
  thread.output.replaceChildren(element('h4', '', 'Findings'), list);
  thread.output.hidden = false;
}

function notice(label: string, text: string): HTMLElement {
  const node = element('aside', 'notice tone-warning');
  node.append(element('strong', '', label), element('div', '', text));
  return node;
}

function applyResolution(card: ApprovalCard, result: ApprovalResult): void {
  const allowed = result.decision === 'allow';
  paintChip(card.status, allowed ? 'Allowed' : 'Denied', allowed ? 'success' : 'error');
  card.actions.hidden = true;
  card.reason.textContent = result.reason ?? '';
  card.reason.hidden = !result.reason;
}

function showApproval(run: Run, event: ApprovalRequest): void {
  const { call, kind } = event;
  if (run.approvals.has(call.callId)) return;

  const node = element('section', 'approval');
  const header = element('div', 'approval-header');
  const heading = element('h3');
  const status = chip(kind === 'edit' ? 'In editor' : 'Awaiting approval', 'warning');
  header.append(heading, status);
  const detail = kind === 'edit' ? element('p') : element('pre', 'mono');
  const reason = element('p', 'muted');
  reason.hidden = true;
  const actions = element('div', 'approval-actions');
  const card = { reason, status, actions };
  node.append(header, detail, reason, actions);

  if (kind === 'edit') {
    const path = argText(call.args, ['path', 'relPath', 'filePath', 'file_path']) ?? 'file';
    heading.append('Reviewing ', element('span', 'mono', path));
    detail.textContent = 'Accept or reject each hunk in the editor.';
    actions.hidden = true;
  } else {
    heading.textContent = kind === 'command' ? 'Command approval' : `Approve ${call.name}`;
    detail.textContent = kind === 'command'
      ? argText(call.args, ['command', 'cmd']) ?? call.name
      : JSON.stringify(call.args, null, 2);
    const decide = (decision: Decision) => {
      actions.querySelectorAll('button').forEach(control => { control.disabled = true; });
      paintChip(status, 'Submitting decision…', 'warning');
      post({ type: 'approval', callId: call.callId, decision });
    };
    actions.append(
      button('Allow', 'primary', () => decide('allow')),
      button('Allow for session', 'secondary', () => decide('allow-session')),
      button('Deny', 'secondary deny', () => decide('deny')),
    );
  }
  threadFor(run, call.threadId).body.append(node);
  run.approvals.set(call.callId, card);
  const resolution = run.approvalResults.get(call.callId);
  if (resolution) applyResolution(card, resolution);
}

function createRun(runId: string): Run {
  const section = element('article', 'run');
  const prompt = element('div', 'prompt');
  prompt.hidden = true;
  const main = { body: element('div', 'timeline'), messages: new Map<string, TextBlock>() };

  const changesSection = element('section', 'changes');
  const changesList = element('div', 'changes-list');
  const undoAll = button('Undo all changes from this run', 'link', () => post({ type: 'undoRun', runId }));
  changesSection.append(element('h3', '', 'Changes'), changesList, undoAll);
  changesSection.hidden = true;

  const footer = element('footer', 'run-footer');
  footer.hidden = true;
  const noChanges = element('p', 'muted', 'No files were changed by the failed run');
  noChanges.hidden = true;
  section.append(prompt, main.body, changesSection, footer, noChanges);
  return {
    section, prompt, main, hasMainText: false, subagents: new Map(), tools: new Map(),
    approvals: new Map(), approvalResults: new Map(), compactions: new Map(), changesSection, changesList, changes: new Map(),
    undone: new Set(), undoAll, noChanges, footer,
  };
}

function showChange(run: Run, change: AppliedChangeSummary): void {
  let entry = run.changes.get(change.id);
  if (!entry) {
    const row = element('div', 'change');
    const open = () => post({ type: 'openChange', changeId: change.id });
    const path = button(change.relPath, 'link file-link mono', open);
    path.title = change.relPath;
    const stats = element('div', 'change-stats');
    const added = element('span', 'added mono');
    const removed = element('span', 'removed mono');
    const hunks = element('span', 'muted');
    const state = chip('Undone');
    stats.append(added, removed, hunks, state);

    const actions = element('div', 'change-actions');
    const undo = button('Undo', 'secondary', () => post({ type: 'undo', changeId: change.id }));
    actions.append(button('Open', 'secondary', open), undo);
    row.append(path, stats, actions);
    run.changesList.append(row);
    entry = { row, path, added, removed, hunks, undo, state, undone: false };
    run.changes.set(change.id, entry);
  }

  entry.path.textContent = change.relPath;
  entry.path.title = change.relPath;
  entry.added.textContent = `+${count(change.linesAdded)}`;
  entry.removed.textContent = `−${count(change.linesRemoved)}`;
  entry.hunks.textContent = `hunks ${change.hunksApplied}/${change.hunksTotal}`;
  setUndone(entry, change.undone || run.undone.has(change.id) || entry.undone);
  syncChangesSection(run);
}

function setUndone(entry: ChangeRow, undone: boolean): void {
  entry.undone = undone;
  entry.row.classList.toggle('is-undone', undone);
  entry.state.hidden = !undone;
  entry.undo.disabled = undone;
}

function syncChangesSection(run: Run): void {
  run.changesSection.hidden = run.changes.size === 0;
  run.undoAll.disabled = !Array.from(run.changes.values()).some(change => !change.undone);
  if (run.changes.size) run.noChanges.hidden = true;
}

function finishRun(run: Run, event: Extract<UiEvent, { type: 'run.done' }>): void {
  const { status, model, modelsTried, elapsedMs, usage, error, text } = event;
  if (!run.hasMainText && text.trim()) {
    const fallback = element('div', 'markdown assistant');
    renderMarkdown(fallback, text);
    run.main.body.append(fallback);
    run.hasMainText = true;
  }
  const labels = { done: 'Done', cancelled: 'Cancelled', error: 'Error' };
  const tones = { done: 'success', cancelled: 'warning', error: 'error' };
  const metrics = element('div', 'run-metrics');
  metrics.append(chip(labels[status], tones[status]), element('span', 'footer-model mono', model),
    element('span', 'muted', duration(elapsedMs)));

  const usageParts: string[] = [];
  if (usage?.inputTokens !== undefined) usageParts.push(`${count(usage.inputTokens)} in`);
  if (usage?.outputTokens !== undefined) usageParts.push(`${count(usage.outputTokens)} out`);
  if (usage?.cacheReadTokens !== undefined) usageParts.push(`${count(usage.cacheReadTokens)} cached`);
  if (usageParts.length) metrics.append(element('span', 'muted', `Tokens · ${usageParts.join(' · ')}`));
  run.footer.replaceChildren(metrics);
  if (modelsTried.length) {
    run.footer.append(element('div', 'models-tried muted', `Tried ${modelsTried.join(' → ')}`));
  }
  if (status === 'error') run.footer.append(element('div', 'error-message tone-error', error ?? 'The run failed.'));
  run.footer.hidden = false;
  run.noChanges.hidden = status !== 'error' || run.changes.size > 0;
}

export class Transcript {
  private readonly runs = new Map<string, Run>();
  private readonly dirty = new Set<TextBlock>();
  private changesByRun = new Map<string, AppliedChangeSummary[]>();
  private frame = 0;

  constructor(
    private readonly content: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly onUpdate: () => void,
  ) {}

  reset(): void {
    this.runs.clear();
    this.changesByRun.clear();
    this.dirty.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.content.replaceChildren();
    this.empty.hidden = false;
    this.onUpdate();
  }

  syncChanges(changes: AppliedChangeSummary[]): void {
    this.changesByRun = new Map();
    for (const change of changes) {
      const recorded = this.changesByRun.get(change.runId) ?? [];
      recorded.push(change);
      this.changesByRun.set(change.runId, recorded);
      const run = this.runs.get(change.runId);
      if (run) showChange(run, change);
    }
    this.onUpdate();
  }

  ingest(event: UiEvent): void {
    const run = this.runFor(event.runId);
    const body = run.main.body;
    switch (event.type) {
      case 'run.started':
        run.prompt.replaceChildren(element('span', 'prompt-label', 'You'), element('div', '', event.prompt));
        run.prompt.hidden = false;
        break;
      case 'text.delta':
      case 'reasoning.delta':
        this.addDelta(run, event);
        return;
      case 'tool.call': {
        const tool = upsertTool(run, threadFor(run, event.threadId), event.callId, event.name, event.server);
        tool.name.textContent = event.name;
        if (event.server) tool.name.title = `${event.server} · ${event.name}`;
        const args = argText(event.args, ['path', 'relPath', 'filePath', 'file_path', 'query', 'command', 'cmd',
          'symbol', 'name', 'pattern']);
        if (args) {
          tool.args.title = args;
          tool.args.textContent = args.replace(/\s+/g, ' ').trim();
        } else if (!tool.args.title && event.argsChars) {
          tool.args.textContent = `${count(event.argsChars)} argument chars`;
        }
        if (!tool.result.textContent || ['done', 'error', 'denied'].includes(event.status)) {
          setToolStatus(tool, event.status);
        }
        break;
      }
      case 'tool.result': {
        const tool = upsertTool(run, threadFor(run, event.threadId), event.callId, event.name);
        tool.result.textContent = event.summary || (event.ok ? 'Completed.' : 'The tool failed.');
        tool.row.classList.add('has-result');
        tool.summary.removeAttribute('tabindex');
        if (tool.currentStatus !== 'denied') setToolStatus(tool, event.ok ? 'done' : 'error');
        break;
      }
      case 'subagent.started': {
        const thread = subagentFor(run, event.threadId);
        thread.label.textContent = `Sub-agent: ${event.name}`;
        thread.label.title = event.input;
        break;
      }
      case 'subagent.done':
        scoutOutput(subagentFor(run, event.threadId), event.ok, event.output);
        break;
      case 'context.selected':
        body.append(contextCard(event.result));
        break;
      case 'compaction': {
        const threadId = event.threadId ?? 'main';
        if (event.phase === 'started') {
          run.compactions.set(threadId, event);
          break;
        }
        const start = run.compactions.get(threadId);
        run.compactions.delete(threadId);
        const used = event.contextTokens ?? start?.contextTokens;
        const threshold = event.thresholdTokens ?? start?.thresholdTokens;
        const limits = used !== undefined && threshold !== undefined
          ? ` (${compactCount(used)} → threshold ${compactCount(threshold)})` : '';
        threadFor(run, event.threadId).body.append(element('div', 'divider', `Context compacted${limits}`));
        break;
      }
      case 'model.retry':
        body.append(notice('Retrying model',
          `Model ${event.model} failed: ${event.error} — retrying in ${duration(event.delayMs)} (attempt ${event.attempt}/${event.maxAttempts})`));
        break;
      case 'model.fallback':
        body.append(notice('Model fallback',
          `Primary model ${event.from} failed (${event.error}) → switched automatically to ${event.to}`));
        break;
      case 'approval.requested':
        showApproval(run, event);
        break;
      case 'approval.resolved': {
        run.approvalResults.set(event.callId, event);
        const card = run.approvals.get(event.callId);
        if (card) applyResolution(card, event);
        const tool = run.tools.get(event.callId);
        if (tool?.currentStatus === 'awaiting-approval') {
          setToolStatus(tool, event.decision === 'allow' ? 'running' : 'denied');
        }
        break;
      }
      case 'change.applied':
        showChange(run, event.change);
        break;
      case 'change.undone': {
        run.undone.add(event.changeId);
        const change = run.changes.get(event.changeId);
        if (change) setUndone(change, true);
        syncChangesSection(run);
        break;
      }
      case 'run.done':
        finishRun(run, event);
        break;
    }
    this.onUpdate();
  }

  private runFor(runId: string): Run {
    const existing = this.runs.get(runId);
    if (existing) return existing;

    const run = createRun(runId);
    this.runs.set(runId, run);
    this.empty.hidden = true;
    this.content.append(run.section);
    for (const change of this.changesByRun.get(runId) ?? []) showChange(run, change);
    return run;
  }

  private addDelta(run: Run, event: Delta): void {
    const thread = threadFor(run, event.threadId);
    const markdown = event.type === 'text.delta';
    if (markdown && thread === run.main && event.text.trim()) run.hasMainText = true;
    const key = `${event.type}:${event.messageId}`;
    let block = thread.messages.get(key);
    if (!block) {
      const content = element('div', markdown ? 'markdown assistant' : 'thinking-text');
      if (markdown) {
        thread.body.append(content);
      } else {
        const thinking = disclosure('Thinking', 'thinking');
        thinking.append(content);
        thread.body.append(thinking);
      }
      block = { body: content, source: '', markdown };
      thread.messages.set(key, block);
    }
    block.source += event.text;
    this.dirty.add(block);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.frame = 0;
    for (const block of this.dirty) {
      if (block.markdown) renderMarkdown(block.body, block.source);
      else block.body.textContent = block.source;
    }
    this.dirty.clear();
    this.onUpdate();
  }
}
