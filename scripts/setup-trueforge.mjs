#!/usr/bin/env node
// Registers Anvil's model providers and agents in a local TrueForge (npm run setup).
//
//   npm run setup                     register providers whose keys are set, upsert the agents
//   npm run setup -- --status         print health, providers, models and agents
//   npm run demo:failure              create a dedicated unreachable provider for Task C
//   options: --url http://127.0.0.1:8790 (or TRUEFORGE_URL)
//
// Keys are read from process.env, then ../.env, then .env (never printed, never written to the repo).
// Providers come from config/models.json if present, else config/models.example.json.
// Plain Node >= 22, no dependencies.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER_NAME = 'anvil-editor';
const PLACEHOLDER_MCP_URL = 'http://127.0.0.1:43117/mcp';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = (option('--url') ?? process.env.TRUEFORGE_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');

/* ───────────── env ───────────── */

function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const envSources = [process.env, parseEnvFile(join(ROOT, '..', '.env')), parseEnvFile(join(ROOT, '.env'))];
function envValue(name) {
  for (const src of envSources) {
    const v = src[name];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function substitute(value) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => envValue(n) ?? '');
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  return value;
}

/* ───────────── http ───────────── */

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const e = new Error(
      `TrueForge is not reachable at ${BASE} (${err?.cause?.code ?? err?.message}). Start it first with \`npm run trueforge\` ` +
        `(or pass --url / TRUEFORGE_URL).`,
    );
    e.unreachable = true;
    throw e;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? (typeof json === 'string' ? json : res.statusText);
    const e = new Error(`${method} ${path} -> ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/* ───────────── config ───────────── */

function loadModelsConfig() {
  for (const f of ['models.json', 'models.example.json']) {
    const p = join(ROOT, 'config', f);
    if (existsSync(p)) return { file: `config/${f}`, cfg: JSON.parse(readFileSync(p, 'utf8')) };
  }
  throw new Error('config/models.example.json is missing');
}

function providerName(manifest) {
  return manifest.type === 'custom' || manifest.type === 'truefoundry' ? manifest.name : manifest.type;
}

function providerModels(manifest) {
  return (manifest.models ?? []).map((m) => `${providerName(manifest)}/${m.name}`);
}

function loadAgents() {
  const dir = join(ROOT, 'agents');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function withModel(manifest, model) {
  const m = JSON.parse(JSON.stringify(manifest).split('${PRIMARY_MODEL}').join(model));
  m.model = { ...(m.model ?? {}), name: model };
  return m;
}

async function configuredModels() {
  const r = await api('GET', '/api/v1/models');
  return (r?.data ?? []).map((m) => m.name);
}

async function listAgents() {
  const r = await api('GET', '/api/v1/agents?limit=50');
  return r?.data ?? [];
}

function chainFrom(cfg, available) {
  const preferred = (cfg.chain ?? []).filter((m) => available.includes(m));
  return [...preferred, ...available.filter((m) => !preferred.includes(m))];
}

/* ───────────── commands ───────────── */

async function putProvider(manifest) {
  await api('PUT', '/api/v1/settings/model-providers', { manifest });
}

async function registerProviders(cfg) {
  const registered = [];
  for (const p of cfg.providers ?? []) {
    const name = providerName(p.manifest);
    const key = p.env ? envValue(p.env) : 'none';
    if (!key) {
      console.log(`  - ${name}: skipped (${p.env} is not set${p.optional ? ', optional' : ''})`);
      continue;
    }
    try {
      await putProvider(substitute(p.manifest));
      registered.push(name);
      console.log(`  ✓ ${name}: ${providerModels(p.manifest).join(', ')}`);
    } catch (err) {
      if (err.unreachable) throw err;
      console.log(`  ✗ ${name}: ${err.message}`);
    }
  }
  return registered;
}

async function ensureMcpPlaceholder() {
  const r = await api('GET', '/api/v1/settings/mcp-servers');
  const exists = (r?.data ?? []).some((s) => (s?.name ?? s?.manifest?.name) === MCP_SERVER_NAME);
  if (exists) return false;
  // The extension overwrites this with its real port + per-activation token when it starts.
  await api('PUT', '/api/v1/settings/mcp-servers', {
    manifest: {
      type: 'remote',
      name: MCP_SERVER_NAME,
      url: PLACEHOLDER_MCP_URL,
      description: "Anvil editor tools for the user's open VS Code workspace (placeholder until the extension starts).",
      auth: { type: 'header', headers: { 'x-anvil-token': 'set-by-the-extension' } },
    },
  });
  return true;
}

async function upsertAgents(primary) {
  const existing = await listAgents();
  for (const def of loadAgents()) {
    const manifest = withModel(def.manifest, primary);
    const found = existing.find((a) => a.name === def.name);
    if (found) await api('PUT', `/api/v1/agents/${encodeURIComponent(found.id)}`, { description: def.description, manifest });
    else await api('POST', '/api/v1/agents', { name: def.name, description: def.description, manifest });
    console.log(`  ✓ ${def.name} (${found ? 'updated' : 'created'}, model ${primary})`);
  }
}

async function setup() {
  const { file, cfg } = loadModelsConfig();
  const health = await api('GET', '/healthz');
  console.log(`TrueForge ${health?.version ?? '?'} at ${BASE}`);
  console.log(`Model providers (${file}):`);
  const registered = await registerProviders(cfg);
  const available = await configuredModels();
  if (!available.length) {
    console.log(
      '\nNo models are configured. Put at least one key (GEMINI_API_KEY, GROQ_API_KEY or CEREBRAS_API_KEY) in your environment, ' +
        `${join(ROOT, '..', '.env')} or ${join(ROOT, '.env')}, then run \`npm run setup\` again.`,
    );
    process.exitCode = 1;
    return;
  }
  const chain = chainFrom(cfg, available);
  console.log(`\nConfigured models: ${available.join(', ')}`);
  if (!registered.length) console.log('(no provider registered in this run; using the ones already in TrueForge)');

  if (await ensureMcpPlaceholder()) console.log(`\nRegistered a placeholder ${MCP_SERVER_NAME} MCP server (${PLACEHOLDER_MCP_URL}); the extension replaces it.`);
  console.log('\nAgents:');
  await upsertAgents(chain[0]);

  console.log('\nModel chain (first = primary, the rest are automatic fallbacks). Put this in your VS Code settings:');
  console.log(`  "anvil.models": ${JSON.stringify(chain)}`);
  if (chain.length < 2) console.log('  Note: only one model is configured, so there is nothing to fall back to. Add a second provider key for Task C.');
  console.log(`\nSessions UI: ${BASE}/`);
}

async function status() {
  let health;
  try {
    health = await api('GET', '/healthz');
  } catch (err) {
    console.log(`TrueForge: DOWN — ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`TrueForge: ${health?.status ?? 'ok'} (version ${health?.version ?? '?'}) at ${BASE}`);
  const providers = (await api('GET', '/api/v1/settings/model-providers'))?.data ?? [];
  console.log(`Providers (${providers.length}):`);
  for (const p of providers) {
    const m = p.manifest ?? p;
    console.log(`  - ${p.name ?? providerName(m)} [${m.type}] ${(m.models ?? []).map((x) => x.name).join(', ')}`);
  }
  const models = await configuredModels();
  console.log(`Models (${models.length}): ${models.join(', ') || '(none)'}`);
  const { cfg } = loadModelsConfig();
  console.log(`Chain: ${JSON.stringify(chainFrom(cfg, models))}`);
  const mcp = (await api('GET', '/api/v1/settings/mcp-servers'))?.data ?? [];
  for (const s of mcp) {
    const m = s.manifest ?? s;
    console.log(`MCP server: ${m.name} -> ${m.url ?? m.type}`);
  }
  const agents = await listAgents();
  console.log(`Agents (${agents.length}):`);
  for (const a of agents) console.log(`  - ${a.name}: model ${a.manifest?.model?.name ?? '?'}`);
}

async function main() {
  const unknown = argv.find(arg => arg.startsWith('-') && !['--help', '-h', '--status', '--url'].includes(arg));
  if (unknown) throw new Error(`Unknown option ${unknown}. Use npm run demo:failure for resilience testing.`);
  if (flag('--help') || flag('-h')) {
    console.log(`Register Anvil providers and agents in local TrueForge.

npm run setup                     Register configured providers and agents
npm run setup -- --status         Show health, model names, and agents
npm run setup -- --url URL        Use a different TrueForge server
npm run demo:failure              Create the dedicated Task C failure provider

Keys are read from the environment or ignored .env files and never printed.
Providers: config/models.json, falling back to config/models.example.json.`);
    return;
  }
  if (flag('--status')) return status();
  return setup();
}

main().catch((err) => {
  console.error(`\nsetup failed: ${err.message}`);
  process.exitCode = 1;
});
