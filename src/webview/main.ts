import type { HostToPanel, IndexStats, PanelState, TrueForgeHealth } from '../shared/contracts';
import { Composer } from './composer';
import { button, count, element, post } from './render';
import { Transcript } from './transcript';

const header = element('header', 'panel-header');
const topBar = element('div', 'top-bar');
const brand = element('div', 'brand');
brand.append(element('span', 'brand-mark', '✳'), element('strong', '', 'Anvil'), element('span', 'brand-label', 'CODE'));
const health = element('div', 'health muted');
const healthDot = element('span', 'health-dot');
healthDot.setAttribute('aria-hidden', 'true');
health.append(healthDot, 'TrueForge');
health.title = 'Waiting for TrueForge status';
health.setAttribute('aria-label', 'Waiting for TrueForge status');
const actions = element('div', 'header-actions');
const session = button('Session ↗', 'link', () => post({ type: 'openSession' }));
session.disabled = true;
actions.append(session, button('New', 'secondary', () => post({ type: 'newChat' })));
topBar.append(brand, actions);

const models = button('', 'model-chain', () => post({ type: 'selectModel' }));
models.title = 'Select model chain';
const index = element('div', 'index-stats muted');
index.hidden = true;
const connection = element('div', 'connection-bar');
connection.append(health, index);
header.append(topBar, connection);

const scroller = element('main', 'scroller');
scroller.setAttribute('aria-label', 'Agent transcript');
const transcriptContent = element('div', 'transcript');
const empty = element('section', 'empty');
const welcome = element('div', 'welcome');
welcome.append(element('div', 'welcome-mark', '✳'), element('p', 'eyebrow', 'YOUR WORKSPACE, IN FOCUS'),
  element('h1', '', 'What shall we build?'),
  element('p', 'welcome-description', 'Explore the code. Make a change. Review every detail.'));
const starters = element('div', 'starter-list');
for (const [icon, title, detail, prompt] of [
  ['⌕', 'Understand this codebase', 'Find the architecture and entry points', 'Explain the architecture of this workspace and its main entry points.'],
  ['↗', 'Build something', 'Turn an idea into a reviewed change', 'I want to add a feature: '],
  ['✓', 'Find a bug', 'Trace a problem and verify the fix', 'Help me investigate this problem: '],
]) {
  const starter = button('', 'starter', () => composer.setDraft(prompt));
  const label = element('span', 'starter-label');
  label.append(element('strong', '', title), element('span', 'muted', detail));
  starter.append(element('span', 'starter-icon', icon), label, element('span', 'starter-arrow', '↗'));
  starters.append(starter);
}
empty.append(welcome, starters);
scroller.append(empty, transcriptContent);
const composerContainer = element('div', 'composer');
const activity = element('div', 'activity muted');
activity.setAttribute('role', 'status');
activity.hidden = true;
const activityText = element('span', '', 'Working…');
activity.append(element('span', 'activity-dot'), activityText);
const latest = button('↓ Latest', 'latest-button', () => {
  follow = true;
  scroller.scrollTop = scroller.scrollHeight;
  latest.hidden = true;
});
latest.hidden = true;
composerContainer.append(latest, activity, models);
document.body.append(header, scroller, composerContainer);

let follow = true;
let scrollFrame = 0;
function scheduleScroll(): void {
  if (!follow || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    latest.hidden = follow;
  });
}

// Only a user-initiated scroll (wheel, touch, keys, scrollbar drag) may stop auto-follow;
// content growing in large chunks (a tool card, a context card) must not.
let userScrolling = false;
for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown'] as const) {
  scroller.addEventListener(ev, () => { userScrolling = true; }, { passive: true });
}
scroller.addEventListener('scroll', () => {
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
  if (nearBottom) follow = true;
  else if (userScrolling) follow = false;
  userScrolling = false;
  latest.hidden = follow;
}, { passive: true });
const observer = new ResizeObserver(scheduleScroll);
observer.observe(transcriptContent);
observer.observe(scroller);

const transcript = new Transcript(transcriptContent, empty, scheduleScroll);
const composer = new Composer(composerContainer);
let state: PanelState | undefined;
let latestRun: { id: string; sessionId?: string; model: string } | undefined;

function showHealth(status: TrueForgeHealth): void {
  const label = status.ok ? 'TrueForge connected' : 'TrueForge disconnected';
  health.className = status.ok ? 'health tone-success' : 'health tone-error';
  health.title = [label, status.url, status.version ? `Version ${status.version}` : undefined, status.error]
    .filter(Boolean).join('\n');
  health.setAttribute('aria-label', label);
}

function showModels(activeModel = state?.activeModel): void {
  const modelChain = state?.models ?? [];
  const configured = activeModel && !modelChain.includes(activeModel) ? [...modelChain, activeModel] : modelChain;
  const nodes: Node[] = [];
  configured.forEach((name, position) => {
    if (position) {
      const arrow = element('span', 'model-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      nodes.push(arrow);
    }
    const entry = element('span', 'model');
    const active = name === activeModel;
    entry.classList.toggle('is-active', active);
    if (active) entry.setAttribute('aria-current', 'true');
    entry.append(element('span', 'model-name mono', name));
    nodes.push(entry);
  });
  if (!nodes.length) nodes.push(element('span', 'muted', 'Select a model'));
  models.replaceChildren(...nodes);
  models.setAttribute('aria-label', ['Select model chain', configured.join(', '),
    activeModel ? `Active model ${activeModel}` : ''].filter(Boolean).join('. '));
}

function showSession(url?: string): void {
  session.disabled = !url;
  session.title = url ?? 'Start a run to open its TrueForge session';
}

function showIndex(stats?: IndexStats): void {
  index.hidden = !stats;
  if (!stats) return;
  const workspace = document.body.dataset.workspace;
  const prefix = workspace ? `${workspace}: ` : '';
  index.textContent = `${prefix}${count(stats.files)} files · ${count(stats.chunks)} chunks`;
}

function updateState(next: PanelState): void {
  state = next;
  showHealth(next.trueforge);
  // The host snapshot can report the configured primary after a run falls back.
  const observed = latestRun?.sessionId === next.sessionId ? latestRun?.model : undefined;
  const configuredFallback = next.activeModel !== next.models[0] ? next.activeModel : undefined;
  showModels(configuredFallback ?? (observed && next.models.includes(observed) ? observed : next.activeModel));
  showSession(next.sessionUrl);
  showIndex(next.index);
  transcript.syncChanges(next.changes);
  composer.setRunning(next.running);
  activity.hidden = !next.running;
  models.disabled = next.running;
  document.body.classList.toggle('is-running', next.running);
}

showModels();
window.addEventListener('message', ({ data }: MessageEvent<HostToPanel>) => {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'state':
      updateState(data.state);
      break;
    case 'event': {
      const event = data.event;
      transcript.ingest(event);
      if (event.type === 'run.started') {
        activity.hidden = false;
        activityText.textContent = 'Working…';
        composer.setRunning(true);
        models.disabled = true;
        document.body.classList.add('is-running');
        follow = true;
        scheduleScroll();
        latestRun = { id: event.runId, sessionId: event.sessionId, model: event.model };
        showSession(event.sessionUrl);
        showModels(event.model);
      } else if (event.type === 'model.fallback' || event.type === 'run.done') {
        if (event.type === 'run.done') {
          activity.hidden = true;
          composer.setRunning(false);
          models.disabled = false;
          document.body.classList.remove('is-running');
        } else activityText.textContent = 'Switching to fallback…';
        if (!latestRun || latestRun.id === event.runId) {
          const model = event.type === 'model.fallback' ? event.to : event.model;
          latestRun = { id: event.runId, sessionId: latestRun?.sessionId ?? state?.sessionId, model };
          showModels(model);
        }
      } else if (event.type === 'context.selected' && !state?.index) {
        showIndex(event.result.indexStats);
      }
      if (event.type === 'approval.requested') activityText.textContent = 'Waiting for your review';
      else if (event.type === 'approval.resolved') activityText.textContent = 'Working…';
      else if (event.type === 'model.retry') activityText.textContent = 'Retrying model…';
      else if (event.type === 'tool.call') activityText.textContent = `Working · ${event.name.replaceAll('_', ' ')}`;
      break;
    }
    case 'mentionResults':
      composer.showResults(data);
      break;
    case 'reset':
      follow = true;
      latestRun = undefined;
      showModels();
      showSession();
      transcript.reset();
      composer.setRunning(false);
      activity.hidden = true;
      models.disabled = false;
      latest.hidden = true;
      document.body.classList.remove('is-running');
      break;
  }
});
post({ type: 'ready' });
