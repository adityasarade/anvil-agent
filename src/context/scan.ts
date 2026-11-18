import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextEngineOptions } from '../shared/contracts';
import { parseFile } from './parse';

const excluded = new Set(('.git node_modules .venv venv env __pycache__ dist build out .tox .nox ' +
  '.mypy_cache .pytest_cache .ruff_cache .idea .vscode site-packages').split(' '));
const extensions = /\.(?:pyi?|rst|md|txt|toml|cfg|ini|ya?ml|json|[cm]?js|tsx?|jsx|html|css|sh)$/i;

export function glob(pattern: string): RegExp {
  let expr = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (pattern.startsWith('**/', i)) { expr += '(?:.*/)?'; i += 2; }
    else if (pattern.startsWith('**', i)) { expr += '.*'; i++; }
    else if (c === '*') expr += '[^/]*';
    else if (c === '?') expr += '[^/]';
    else expr += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + expr + '$');
}

export function fileFilter(pattern?: string) {
  if (!pattern) return () => true;
  if (!/[*?]/.test(pattern)) return (p: string) => p.includes(pattern);
  const re = glob(pattern);
  return (p: string) => re.test(p) || (!pattern.includes('/') && re.test(path.posix.basename(p)));
}

export function relative(raw: string): string | undefined {
  const p = path.posix.normalize(raw.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!p || p === '.' || p === '..' || p.startsWith('../') || /^(?:\/|[a-z]:\/)/i.test(p) || p.includes('\0')) return;
  return p;
}

export async function scanner(opts: ContextEngineOptions) {
  const root = await fs.realpath(opts.root);
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  const rules = [...ignore.split(/\r?\n/), ...(opts.exclude ?? [])]
    .map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(raw => {
      const rule = raw.replace(/^!/, '').replace(/\/$/, '');
      return { re: glob(rule.replace(/^\//, '')), anchored: rule.includes('/'), directory: raw.endsWith('/'), negate: raw.startsWith('!') };
    });
  function skip(p: string, directory: boolean) {
    const name = path.posix.basename(p);
    if (directory && (excluded.has(name) || name.endsWith('.egg-info'))) return true;
    let ignored = false;
    for (const rule of rules) {
      if ((!rule.directory || directory) && rule.re.test(rule.anchored ? p : name)) ignored = !rule.negate;
    }
    return ignored;
  }
  async function paths() {
    const files: string[] = [];
    async function walk(dir: string) {
      const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
      await Promise.all(entries.map(async ent => {
        const p = dir ? dir + '/' + ent.name : ent.name;
        if (skip(p, ent.isDirectory())) return;
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile() && extensions.test(p)) files.push(p);
      }));
    }
    await walk('');
    return files.sort();
  }
  async function read(p: string, fromWalk = false) {
    if (!extensions.test(p) || !relative(p)) return;
    const abs = path.join(root, p);
    try {
      if (!fromWalk) {
        const parts = p.split('/');
        if (parts.some((_, i) => skip(parts.slice(0, i + 1).join('/'), i < parts.length - 1))) return;
      }
      if (await fs.realpath(abs) !== abs) return;
      const stat = await fs.stat(abs);
      const limit = opts.maxFileBytes ?? 512 * 1024;
      if (!stat.isFile() || stat.size > limit) return;
      const bytes = await fs.readFile(abs);
      if (bytes.length > limit || bytes.includes(0)) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/[\u0001-\u0008\u000e-\u001a]/.test(text)) return;
      return parseFile(p, text);
    } catch (e) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes((e as NodeJS.ErrnoException).code ?? '')) return;
      throw e;
    }
  }
  return { paths, read };
}
