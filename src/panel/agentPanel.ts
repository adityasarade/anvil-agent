import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostToPanel, PanelHost, PanelState, PanelToHost, ToolCallInfo, UiEvent } from '../shared/contracts';

const EVENT_LIMIT = 3000;

type Approval = Pick<Extract<PanelToHost, { type: 'approval' }>, 'decision' | 'reason'>;
type ApprovalRequest = Extract<UiEvent, { type: 'approval.requested' }>;

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'anvil.agentPanel';

  private view?: vscode.WebviewView;
  private ready = false;
  private readonly events: UiEvent[] = [];
  private readonly approvals = new Map<string, {
    request: ApprovalRequest;
    promise: Promise<Approval>;
    resolve: (approval: Approval) => void;
  }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: PanelHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const { webview } = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [dist, vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    const messages = webview.onDidReceiveMessage((message: PanelToHost) => {
      if (this.view === view) this.receive(message);
    });
    const disposal = view.onDidDispose(() => {
      messages.dispose();
      disposal.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        for (const callId of this.approvals.keys()) {
          this.resolveApproval(callId, { decision: 'deny', reason: 'panel closed' });
        }
      }
    });

    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const workspaceName = (vscode.workspace.name ?? '').replace(/[&"<>]/g, character =>
      ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character] ?? character);
    webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; base-uri 'none'; form-action 'none'">
  <link rel="stylesheet" href="${stylesheet}">
  <title>Anvil Agent</title>
</head>
<body data-workspace="${workspaceName}">
  <script nonce="${nonce}" src="${script}" defer></script>
</body>
</html>`;
  }

  postEvent(event: UiEvent): void {
    this.events.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.shift();
    this.post({ type: 'event', event });
  }

  postState(state: PanelState): void {
    this.post({ type: 'state', state });
  }

  postError(message: string): void {
    this.postEvent({
      type: 'run.done', runId: `startup-${randomBytes(8).toString('hex')}`,
      status: 'error', model: '', text: '', error: message, modelsTried: [], elapsedMs: 0,
    });
  }

  reset(): void {
    this.events.length = 0;
    this.post({ type: 'reset' });
  }

  reveal(): Thenable<unknown> {
    return vscode.commands.executeCommand('anvil.agentPanel.focus');
  }

  requestApproval(call: ToolCallInfo, runId: string): Promise<Approval> {
    const pending = this.approvals.get(call.callId);
    if (pending) return pending.promise;

    const request: ApprovalRequest = {
      type: 'approval.requested',
      runId,
      call,
      kind: call.name === 'run_command' ? 'command' : 'other',
    };
    let resolve!: (approval: Approval) => void;
    const promise = new Promise<Approval>(settle => { resolve = settle; });
    this.approvals.set(call.callId, { request, promise, resolve });
    this.postEvent(request);
    return promise;
  }

  cancelApprovals(runId: string): void {
    for (const [callId, { request }] of this.approvals) {
      if (request.runId === runId) {
        this.resolveApproval(callId, { decision: 'deny', reason: 'run cancelled' });
      }
    }
  }

  private receive(message: PanelToHost): void {
    switch (message.type) {
      case 'ready': {
        this.ready = true;
        this.postState(this.host.state());
        const replayedApprovals = new Set<string>();
        for (const event of this.events) {
          this.post({ type: 'event', event });
          if (event.type === 'approval.requested') replayedApprovals.add(event.call.callId);
        }
        // Active approvals must remain actionable even after the event buffer rolls over.
        for (const [callId, { request }] of this.approvals) {
          if (!replayedApprovals.has(callId)) this.post({ type: 'event', event: request });
        }
        break;
      }
      case 'send': this.host.send(message.text, message.mentions); break;
      case 'cancel': this.host.cancel(); break;
      case 'newChat': this.host.newChat(); break;
      case 'approval': this.resolveApproval(message.callId, message); break;
      case 'openChange': this.host.openChange(message.changeId); break;
      case 'undo': this.host.undo(message.changeId); break;
      case 'undoRun': this.host.undoRun(message.runId); break;
      case 'openSession': this.host.openSession(); break;
      case 'selectModel': this.host.selectModel(); break;
      case 'openFile':
        if (typeof message.path === 'string' && message.path &&
            !/^(?:\/|[a-z]:)|[\\\0]/i.test(message.path) && !message.path.split('/').includes('..')) {
          const line = message.line;
          this.host.openFile(message.path, line && Number.isSafeInteger(line) && line > 0 ? line : undefined);
        }
        break;
      case 'mentionQuery':
        this.post({ type: 'mentionResults', requestId: message.requestId, items: this.host.suggest(message.prefix) });
        break;
    }
  }

  private resolveApproval(callId: string, { decision, reason }: Approval): void {
    const pending = this.approvals.get(callId);
    if (!pending || !['allow', 'deny', 'allow-session'].includes(decision)) return;
    this.approvals.delete(callId);
    pending.resolve({ decision, reason });
    this.postEvent({
      type: 'approval.resolved',
      runId: pending.request.runId,
      callId,
      decision: decision === 'deny' ? 'deny' : 'allow',
      reason,
    });
  }

  private post(message: HostToPanel): void {
    if (this.ready) void this.view?.webview.postMessage(message);
  }
}
