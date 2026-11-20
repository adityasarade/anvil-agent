import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { marked } from 'marked';

mkdirSync('.artifacts', { recursive: true });
for (const [source, name, title] of [
  ['video-script.md', 'anvil-demo-script', 'Team Asterix — four minute demo script'],
  ['run-demo.md', 'anvil-run-demo-steps', 'Anvil — exact run and demo steps'],
]) {
  const html = `.artifacts/${name}.html`;
  const content = readFileSync(`docs/submission/${source}`, 'utf8');
  writeFileSync(html, `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>
@page{size:A4;margin:14mm}body{font:10pt/1.45 Arial,sans-serif;color:#17202a;margin:0}h1{font-size:21pt;line-height:1.15;color:#123c52}h2{font-size:14pt;margin-top:7mm;break-after:avoid}h3{break-after:avoid}p{margin:2.5mm 0}a{color:#165b80;text-decoration:none}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{border:1px solid #b9c8ce;padding:2mm;vertical-align:top}th{background:#eaf2f5}tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f4f6;padding:3mm;border-left:2px solid #39738d;break-inside:avoid;font-size:8.5pt}code{font-family:Menlo,monospace;font-size:8.5pt}li{margin:1.5mm 0}blockquote{margin-left:0;border-left:2px solid #39738d;padding-left:3mm}
</style><body>${marked.parse(content)}</body></html>`);
  const result = spawnSync(process.execPath, ['scripts/export-writeup.mjs', html, `.artifacts/${name}.pdf`], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
