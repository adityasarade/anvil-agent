// Exercises the bundled panel in Chrome with the same CSP shape as the editor.
// No provider calls, browser automation packages, or model downloads required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = process.env.ANVIL_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(browser)) throw new Error('Set ANVIL_CHROME to Chrome/Chromium.');
mkdirSync('.artifacts', { recursive: true });
const url = path => pathToFileURL(resolve(path)).href;
writeFileSync('.artifacts/panel-theme.css', `:root{--vscode-sideBar-background:#191919;--vscode-editor-background:#191919;--vscode-editorWidget-background:#232323;--vscode-input-background:#232323;--vscode-editor-foreground:#e4e2df;--vscode-sideBar-foreground:#e4e2df;--vscode-descriptionForeground:#999895;--vscode-testing-iconPassed:#8bbd96;--vscode-editorWarning-foreground:#d8b76b;--vscode-errorForeground:#e58e8e;--vscode-font-family:Arial,sans-serif;--vscode-editor-font-family:Menlo,monospace;--vscode-list-hoverBackground:#ffffff0a;--vscode-focusBorder:#d48d70;--vscode-input-placeholderForeground:#8b8986}:root:has(body.vscode-light){--vscode-sideBar-background:#faf9f7;--vscode-editor-background:#faf9f7;--vscode-editorWidget-background:#fff;--vscode-input-background:#fff;--vscode-editor-foreground:#26231f;--vscode-sideBar-foreground:#26231f;--vscode-descriptionForeground:#746f68;--vscode-list-hoverBackground:#00000008}`);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-preview'; style-src file:; img-src file: data:; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="${url('dist/webview.css')}"><link rel="stylesheet" href="${url('.artifacts/panel-theme.css')}"></head><body data-workspace="flask">
<script nonce="preview">
window.sent=[];window.saved={draft:'Recovered local draft'};
window.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value},postMessage:message=>{sent.push(message)}});
window.addEventListener('error',event=>{document.body.dataset.error=event.message});
</script><script nonce="preview" src="${url('dist/webview.js')}" defer></script>
<script nonce="preview">
window.addEventListener('DOMContentLoaded',()=>{try{
 const check=(value,message)=>{if(!value)throw Error(message)};
 const emit=data=>window.dispatchEvent(new MessageEvent('message',{data}));
 const event=data=>emit({type:'event',event:{runId:'preview',...data}});
 const input=document.querySelector('textarea');
 const type=text=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}))};
 const state={trueforge:{ok:true,url:'http://127.0.0.1:8790'},models:['groq/qwen3-8-27b'],activeModel:'groq/qwen3-8-27b',running:false,changes:[],index:{files:215,chunks:2817}};
 emit({type:'state',state});
 check(input.value==='Recovered local draft','draft restored');
 document.querySelector('.starter').click();
 check(input.value.startsWith('Explain the architecture'),'starter fills composer');
 check(!sent.some(x=>x.type==='send'),'starter does not send automatically');
 check(saved.draft===input.value,'draft saved');
 type('/model');document.querySelector('.send').click();
 check(sent.at(-1).type==='selectModel','slash command is local');
 check(saved.draft==='','command clears draft');
 document.querySelector('[aria-label="Local commands"]').click();
 check(!document.querySelector('.command-menu').hidden,'command menu opens');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 check(document.querySelector('.command-menu').hidden,'Escape closes menu');
 type('Implement the config command');
 document.querySelector('.send').click();
 check(sent.at(-1).type==='send'&&sent.at(-1).text==='Implement the config command','send payload');
 check(document.querySelector('.send').textContent==='Stop','stop available');
 document.querySelector('.send').click();
 check(sent.at(-1).type==='cancel'&&document.querySelector('.send').disabled,'cancel sent once');
 emit({type:'reset'});
 check(document.querySelector('.empty').hidden===false,'reset shows welcome');
 check(document.querySelector('.send').textContent==='Send ↑','reset releases composer');
 document.querySelector('[aria-label="Mention a file or symbol"]').click();
 check(input.value==='@','mention button inserts trigger');
 type('');
 event({type:'run.started',kind:'agent',sessionId:'demo',model:state.activeModel,sessionUrl:'http://127.0.0.1:8790/sessions/demo',prompt:'Add flask config with JSON output and sensitive values masked.'});
 event({type:'text.delta',threadId:'main',messageId:'answer',text:'I found the CLI entry point, its tests, and the command documentation. I’ll propose a focused change to each.'});
 event({type:'subagent.started',threadId:'scout',name:'context-scout',input:'Locate the CLI command registration.'});
 event({type:'subagent.done',threadId:'scout',ok:true,output:'src/flask/cli.py:980-1010 — Built-in command registration'});
 check(!document.querySelector('.subagent').open,'completed scout collapses');
 event({type:'tool.call',threadId:'main',callId:'read',name:'read_file',args:{path:'src/flask/cli.py'},status:'running'});
 event({type:'tool.result',threadId:'main',callId:'read',name:'read_file',ok:true,summary:'class FlaskGroup(click.Group): ...'});
 check(document.querySelector('.tool').dataset.status==='done','tool result updates status');
 event({type:'approval.requested',kind:'command',call:{callId:'cmd',name:'run_command',threadId:'main',args:{command:'pytest tests/test_cli.py -q'}}});
 check(document.querySelector('.approval-actions .primary'),'approval controls present');
 document.querySelector('.approval-actions .primary').click();
 check(sent.at(-1).type==='approval'&&sent.at(-1).decision==='allow','approval payload');
 event({type:'approval.resolved',callId:'cmd',decision:'allow'});
 check(document.querySelector('.approval-actions').hidden,'approval resolves');
 event({type:'run.done',status:'done',model:state.activeModel,modelsTried:[state.activeModel],text:'Ready for review.',elapsedMs:4200});
 check(document.querySelector('.activity').hidden,'activity ends');
 check(!document.querySelector('.model-chain').disabled,'model picker restored');
 check(!document.body.dataset.error,document.body.dataset.error);
 const mode=new URLSearchParams(location.search).get('mode');
 if(mode==='empty'||mode==='light')emit({type:'reset'});
 if(mode==='light')document.body.classList.add('vscode-light');
 document.body.dataset.status='passed';
}catch(error){document.body.dataset.status='failed';document.body.dataset.failure=error.message;}});
</script></body></html>`;
writeFileSync('.artifacts/panel-preview.html', html);
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const [mode, width] of [['empty', 390], ['active', 390], ['light', 280]]) {
  const profile = mkdtempSync(resolve(tmpdir(), 'anvil-ui-'));
  const child = spawn(browser, ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let socket;
  const pending = new Map();
  try {
    const portFile = resolve(profile, 'DevToolsActivePort');
    for (let i = 0; !existsSync(portFile); i++) {
      if (launchError) throw launchError;
      if (i > 100 || child.exitCode !== null) throw new Error('Chrome did not start');
      await delay(100);
    }
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    socket.onmessage = ({ data }) => {
      const response = JSON.parse(data);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Chrome timeout: ${method}`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${url('.artifacts/panel-preview.html')}?mode=${mode}` });
    let status;
    for (let i = 0; i < 100; i++) {
      const result = await call('Runtime.evaluate', { expression: 'JSON.stringify({status:document.body?.dataset.status,failure:document.body?.dataset.failure})', returnByValue: true });
      status = JSON.parse(result.result.value);
      if (status.status) break;
      await delay(50);
    }
    assert.equal(status.status, 'passed', status.failure || 'Webview did not finish');
    await delay(100);
    const layout = await call('Runtime.evaluate', { expression: 'JSON.stringify({width:innerWidth,content:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(x=>!x.closest("[hidden]")&&x.getBoundingClientRect().right>innerWidth+1).map(x=>x.className)})', returnByValue: true });
    const measured = JSON.parse(layout.result.value);
    assert.equal(measured.width, width);
    assert(measured.content <= width, `Horizontal overflow at ${width}px: ${JSON.stringify(measured)}`);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`.artifacts/panel-${mode}.png`, Buffer.from(screenshot.data, 'base64'));
    checks.push(`${mode} at ${width}px: layout and composer/command/approval interactions`);
    await call('Browser.close');
    await exited;
  } finally {
    socket?.close();
    for (const request of pending.values()) clearTimeout(request.timer);
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(profile, { recursive: true, force: true });
  }
}
writeFileSync('.artifacts/webview-result.json', JSON.stringify({ status: 'passed', checks, verifiedAt: new Date().toISOString() }, null, 2));
console.log('Browser panel checks passed:', checks.join('; '));
