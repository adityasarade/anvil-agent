import { Marked } from 'marked';
import type { HostToPanel, PanelToHost, RetrievalResult } from '../shared/contracts';

declare function acquireVsCodeApi(): {
  postMessage(message: PanelToHost): void;
  getState(): { draft?: string } | undefined;
  setState(state: { draft: string }): void;
};

const vscode = acquireVsCodeApi();
export const post = (message: PanelToHost): void => vscode.postMessage(message);
export const readDraft = (): string => vscode.getState()?.draft ?? '';
export const saveDraft = (draft: string): void => vscode.setState({ draft });
export type MentionResults = Extract<HostToPanel, { type: 'mentionResults' }>;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function paintChip(node: HTMLElement, label: string, tone = 'neutral'): void {
  node.className = `chip tone-${tone}`;
  node.textContent = label;
}

export function chip(label: string, tone?: string): HTMLElement {
  const node = element('span');
  paintChip(node, label, tone);
  return node;
}

export function disclosure(label: string, className: string): HTMLDetailsElement {
  const details = element('details', className);
  details.append(element('summary', '', label));
  return details;
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const count = (value: number): string => number.format(value);
export const compactCount = (value: number): string => compact.format(value).toLowerCase();
export function duration(ms: number): string {
  if (ms < 1000) return `${count(ms)}ms`;
  if (ms < 60_000) return `${count(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

const markdown = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      // Render only explicitly supported URL schemes as navigable links.
      if (!/^https?:\/\//i.test(href)) return label;
      const tooltip = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${tooltip} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(node: HTMLElement, source: string): void {
  node.innerHTML = markdown.parse(source, { async: false });
}

export function fileLink(path: string, line?: number): HTMLButtonElement {
  const link = button(path, 'link file-link mono', () => post({ type: 'openFile', path, line }));
  link.title = line === undefined ? path : `${path}:${line}`;
  return link;
}

export function contextCard(result: RetrievalResult): HTMLElement {
  const card = element('section', 'context-card');
  const header = element('div', 'context-header');
  header.append(element('h3', '', 'Selected context'), chip(`${count(result.files.length)} files`, 'accent'));
  const budget = element('div', 'budget');
  const meter = element('progress');
  meter.max = Math.max(1, result.budgetTokens);
  meter.value = result.usedTokens;
  meter.setAttribute('aria-label', 'Context token budget used');
  const tokens = `${count(result.usedTokens)} / ${count(result.budgetTokens)} tokens`;
  meter.setAttribute('aria-valuetext', tokens);
  budget.append(element('span', '', 'Token budget'), element('span', 'budget-count', tokens), meter);
  card.append(header, budget, element('p', 'strategy', result.strategy));

  const files = element('ul', 'context-files');
  for (const file of result.files) {
    const row = element('li', 'context-file');
    const fileHeader = element('div', 'context-file-header');
    fileHeader.append(fileLink(file.path, file.spans[0]?.startLine), chip(`Score ${count(file.score)}`));
    row.append(fileHeader);
    if (file.reasons.length) {
      const reasons = element('ul', 'reasons');
      for (const reason of file.reasons) reasons.append(element('li', 'reason', reason));
      row.append(reasons);
    }
    if (file.spans.length) {
      const spans = element('ul', 'spans');
      for (const span of file.spans) {
        const lines = span.startLine === span.endLine ? `L${span.startLine}` : `L${span.startLine}–${span.endLine}`;
        const label = span.mode === 'outline' ? `${lines} · outline` : lines;
        const item = element('li', 'span-range mono', label);
        if (span.symbol) item.title = span.symbol;
        spans.append(item);
      }
      row.append(spans);
    }
    files.append(row);
  }
  if (result.files.length) card.append(files);
  const omitted = disclosure(`Omitted (${count(result.omitted.length)})`, 'omitted');
  const omissions = element('ul');
  for (const file of result.omitted) {
    const row = element('li');
    row.append(element('span', 'mono', file.path), element('span', 'muted', file.reason));
    omissions.append(row);
  }
  if (result.omitted.length) omitted.append(omissions);
  else omitted.append(element('p', 'muted', 'No omitted files.'));
  card.append(omitted);
  return card;
}
