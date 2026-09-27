#!/usr/bin/env node
// Turns an lcov file produced by `npm run test:coverage` into a markdown
// report. Writes to $GITHUB_STEP_SUMMARY when set, otherwise stdout.
//
// Usage: node .github/scripts/coverage-summary.mjs [coverage/lcov.info]

import { readFileSync, readdirSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const lcovPath = process.argv[2] ?? 'coverage/lcov.info';
const srcRoot = 'src';
const LEAST_COVERED = 10;

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

function parseLcov(text) {
  const files = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const file = relative(process.cwd(), line.slice(3)).split(sep).join('/');
      cur = { file, lf: 0, lh: 0, bf: 0, bh: 0, fnf: 0, fnh: 0 };
      files.set(file, cur);
    } else if (cur && line.startsWith('LF:')) cur.lf = +line.slice(3);
    else if (cur && line.startsWith('LH:')) cur.lh = +line.slice(3);
    else if (cur && line.startsWith('BRF:')) cur.bf = +line.slice(4);
    else if (cur && line.startsWith('BRH:')) cur.bh = +line.slice(4);
    else if (cur && line.startsWith('FNF:')) cur.fnf = +line.slice(4);
    else if (cur && line.startsWith('FNH:')) cur.fnh = +line.slice(4);
    else if (line === 'end_of_record') cur = null;
  }
  return files;
}

const pct = (hit, total) => (total === 0 ? 100 : (hit / total) * 100);
const fmt = (n) => n.toFixed(1) + '%';

if (!existsSync(lcovPath)) {
  emit(`### Coverage\n\nNo coverage data found at \`${lcovPath}\` (did the test step fail before writing it?).\n`);
  process.exit(0);
}

const covered = parseLcov(readFileSync(lcovPath, 'utf8'));
const allSrc = listSourceFiles(srcRoot);
const loaded = allSrc.filter((f) => covered.has(f)).map((f) => covered.get(f));
const unloaded = allSrc.filter((f) => !covered.has(f));

const sum = (k) => loaded.reduce((a, f) => a + f[k], 0);
const totals = {
  lines: pct(sum('lh'), sum('lf')),
  branches: pct(sum('bh'), sum('bf')),
  functions: pct(sum('fnh'), sum('fnf')),
};

const least = [...loaded].sort((a, b) => pct(a.lh, a.lf) - pct(b.lh, b.lf)).slice(0, LEAST_COVERED);

const row = (f) =>
  `| \`${f.file}\` | ${fmt(pct(f.lh, f.lf))} | ${fmt(pct(f.bh, f.bf))} | ${fmt(pct(f.fnh, f.fnf))} |`;
const header = '| File | Lines | Branches | Functions |\n|---|---:|---:|---:|';

let md = `### Coverage\n\n`;
md += `| | Lines | Branches | Functions |\n|---|---:|---:|---:|\n`;
md += `| **Files loaded by tests** (${loaded.length} of ${allSrc.length} in \`${srcRoot}/\`) | **${fmt(totals.lines)}** | **${fmt(totals.branches)}** | **${fmt(totals.functions)}** |\n\n`;

if (unloaded.length) {
  md += `> ${unloaded.length} source file${unloaded.length === 1 ? '' : 's'} ${unloaded.length === 1 ? 'is' : 'are'} never imported by any test and so ${unloaded.length === 1 ? 'is' : 'are'} not counted above. Real coverage is lower than the headline number.\n\n`;
}

md += `#### Least covered (by lines)\n\n${header}\n${least.map(row).join('\n')}\n\n`;

if (unloaded.length) {
  md += `<details><summary>Never loaded by tests (${unloaded.length})</summary>\n\n`;
  md += unloaded.map((f) => `- \`${f}\``).join('\n') + '\n\n</details>\n\n';
}

md += `<details><summary>All loaded files (${loaded.length})</summary>\n\n${header}\n${loaded.map(row).join('\n')}\n\n</details>\n`;

emit(md);

function emit(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
}
