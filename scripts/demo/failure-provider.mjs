// Adds a dedicated unreachable provider; never reads or replaces real credentials.
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const base = (option('--url') || process.env.TRUEFORGE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const name = 'anvil-demo-failure';
const model = `${name}/unreachable`;
const state = '.artifacts/resilience-provider.json';
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}. Restore the normal model chain and reconnect before removing the demo provider.`);
  return response.json();
}
try {
  if (args.includes('--remove')) {
    if (!existsSync(state) || JSON.parse(readFileSync(state)).base !== base) throw new Error('No demo provider created by this script at this URL.');
    await api('DELETE', `/api/v1/settings/model-providers/${name}`);
    unlinkSync(state);
    console.log('Removed the dedicated demo failure provider. Real providers were untouched.');
  } else {
    const models = (await api('GET', '/api/v1/models')).data.map(item => item.name).filter(item => !item.startsWith(name + '/'));
    const fallback = option('--fallback') || models[0];
    if (!fallback || !models.includes(fallback)) throw new Error('Configure a working model first, or pass --fallback provider/model.');
    const providers = (await api('GET', '/api/v1/settings/model-providers')).data;
    if (providers.some(item => (item.name || item.manifest?.name) === name)) throw new Error('Demo provider already exists. Restore the normal model chain, reconnect, and run with --remove before repeating.');
    const socket = createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await api('PUT', '/api/v1/settings/model-providers', { manifest: {
      type: 'custom', name, base_url: `http://127.0.0.1:${port}/v1`,
      models: [{ model_id: 'unreachable', name: 'unreachable', properties: { context_length: 32000, max_output_tokens: 4000 } }],
    } });
    mkdirSync('.artifacts', { recursive: true });
    writeFileSync(state, JSON.stringify({ base, name, model, fallback, port }, null, 2));
    console.log(`In Anvil: Select Model Chain, choose ${model} first, then ${fallback}.`);
    console.log('Repeat Task A in the clean resilience fixture. Show retries and fallback, then reject the proposal.');
    console.log('Afterward select your normal models, run Anvil: Reconnect to TrueForge, then npm run demo:failure -- --remove.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
