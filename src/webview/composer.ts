import type { Mention, MentionSuggestion } from '../shared/contracts';
import { button, chip, element, post, type MentionResults } from './render';

interface Query {
  start: number;
  end: number;
  prefix: string;
}

function sameQuery(first?: Query, second?: Query): boolean {
  return first?.start === second?.start && first?.end === second?.end && first?.prefix === second?.prefix;
}

function hasMention(text: string, value: string): boolean {
  const token = `@${value}`;
  let index = text.indexOf(token);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + token.length];
    if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) return true;
    index = text.indexOf(token, index + token.length);
  }
  return false;
}

export class Composer {
  private readonly input = element('textarea');
  private readonly pins = element('div', 'mentions');
  private readonly options = element('ul', 'suggestions');
  private readonly send = button('Send', 'primary send', () => this.submitOrStop());
  private mentions: Mention[] = [];
  private items: MentionSuggestion[] = [];
  private activeOption = 0;
  private activeQuery?: Query;
  private dismissedQuery?: Query;
  private requestId = 0;
  private timer = 0;
  private running = false;
  private stopping = false;

  constructor(container: HTMLElement) {
    const box = element('div', 'compose-box');
    this.input.rows = 2;
    this.input.placeholder = 'Ask Anvil to work on your code…';
    this.input.setAttribute('aria-label', 'Message Anvil');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-controls', 'mention-options');
    this.input.setAttribute('aria-describedby', 'composer-hint');
    this.options.id = 'mention-options';
    this.options.setAttribute('role', 'listbox');
    this.options.setAttribute('aria-label', 'Context suggestions');
    this.options.hidden = true;
    this.pins.setAttribute('aria-label', 'Pinned context');
    this.pins.hidden = true;

    const footer = element('div', 'compose-footer');
    const hint = element('p', 'muted', '@file or @symbol to pin context · Esc to stop');
    hint.id = 'composer-hint';
    footer.append(hint, this.send);
    box.append(this.options, this.pins, this.input, footer);
    container.append(box);

    this.input.addEventListener('input', event => {
      this.syncPins();
      this.updateSend();
      if (!(event as InputEvent).isComposing) this.refreshQuery();
    });
    this.input.addEventListener('click', () => this.refreshQuery());
    this.input.addEventListener('select', () => this.refreshQuery());
    this.input.addEventListener('compositionstart', () => this.closeSuggestions());
    this.input.addEventListener('compositionend', () => this.refreshQuery());
    this.input.addEventListener('keyup', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        this.refreshQuery();
      }
    });
    this.input.addEventListener('blur', () => this.closeSuggestions());
    this.input.addEventListener('keydown', event => this.inputKeydown(event));
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !this.running) return;
      event.preventDefault();
      this.stop();
    });
    this.updateSend();
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (!running) this.stopping = false;
    this.updateSend();
  }

  showResults({ requestId, items }: MentionResults): void {
    if (requestId !== this.requestId || !this.activeQuery || !sameQuery(this.queryAtCaret(), this.activeQuery)) return;
    this.items = items;
    this.activeOption = 0;
    this.options.replaceChildren();
    items.forEach((item, index) => {
      const option = element('li', 'suggestion');
      option.id = `mention-option-${index}`;
      option.setAttribute('role', 'option');
      const label = element('div', 'suggestion-label');
      label.append(element('span', 'mono', item.label), chip(item.kind === 'file' ? 'File' : 'Symbol'));
      option.append(label);
      if (item.detail) option.append(element('div', 'suggestion-detail muted mono', item.detail));
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => this.insert(item));
      this.options.append(option);
    });
    this.options.hidden = !items.length;
    this.highlight();
  }

  private submitOrStop(): void {
    if (this.running) {
      this.stop();
      return;
    }
    const text = this.input.value.trim();
    if (!text) return;
    this.syncPins();
    const mentions = this.mentions;
    this.input.value = '';
    this.mentions = [];
    this.syncPins();
    this.closeSuggestions();
    this.setRunning(true);
    this.input.focus();
    post({ type: 'send', text, mentions });
  }

  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.updateSend();
    post({ type: 'cancel' });
  }

  private updateSend(): void {
    this.send.textContent = this.running ? (this.stopping ? 'Stopping…' : 'Stop') : 'Send';
    this.send.classList.toggle('stop', this.running);
    this.send.disabled = this.running ? this.stopping : !this.input.value.trim();
  }

  private syncPins(): void {
    this.mentions = this.mentions.filter(mention => hasMention(this.input.value, mention.value));
    this.pins.replaceChildren(...this.mentions.map(mention => {
      const pin = chip(`@${mention.value}`, 'accent');
      pin.title = mention.kind === 'file' ? 'Pinned file' : 'Pinned symbol';
      return pin;
    }));
    this.pins.hidden = !this.mentions.length;
  }

  private queryAtCaret(): Query | undefined {
    const { selectionStart, selectionEnd, value } = this.input;
    if (selectionStart !== selectionEnd) return;
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, selectionStart));
    if (!match) return;
    const prefix = match[1];
    const trailing = /^[^\s@]*/.exec(value.slice(selectionStart))?.[0] ?? '';
    return { start: selectionStart - prefix.length - 1, end: selectionStart + trailing.length, prefix };
  }

  private refreshQuery(): void {
    const query = this.queryAtCaret();
    if (query && sameQuery(query, this.dismissedQuery)) return;
    this.dismissedQuery = undefined;
    if (sameQuery(query, this.activeQuery)) return;
    this.closeSuggestions();
    if (!query) return;
    this.activeQuery = query;
    const requestId = this.requestId;
    this.timer = window.setTimeout(() => post({ type: 'mentionQuery', requestId, prefix: query.prefix }), 80);
  }

  private closeSuggestions(): void {
    window.clearTimeout(this.timer);
    this.requestId += 1;
    this.activeQuery = undefined;
    this.items = [];
    this.options.hidden = true;
    this.options.replaceChildren();
    this.input.removeAttribute('aria-activedescendant');
  }

  private highlight(scroll = false): void {
    for (const [index, node] of Array.from(this.options.children).entries()) {
      node.setAttribute('aria-selected', String(index === this.activeOption));
    }
    const selected = this.options.children[this.activeOption];
    if (!selected) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.input.setAttribute('aria-activedescendant', selected.id);
    if (scroll) selected.scrollIntoView({ block: 'nearest' });
  }

  private insert(item: MentionSuggestion): void {
    const query = this.activeQuery;
    if (!query) return;
    const { kind, value } = item;
    this.input.setRangeText(`@${value} `, query.start, query.end, 'end');
    if (!this.mentions.some(mention => mention.kind === kind && mention.value === value)) {
      this.mentions.push({ kind, value });
    }
    this.closeSuggestions();
    this.syncPins();
    this.updateSend();
    this.input.focus();
  }

  private inputKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape' && this.items.length) {
      event.preventDefault();
      this.dismissedQuery = this.activeQuery;
      this.closeSuggestions();
      return;
    }
    if (this.items.length) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        this.activeOption = (this.activeOption + direction + this.items.length) % this.items.length;
        this.highlight(true);
        return;
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) {
        event.preventDefault();
        this.insert(this.items[this.activeOption]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!this.running) this.submitOrStop();
    }
  }
}
