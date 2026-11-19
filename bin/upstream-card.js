#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchPRs, summarize, TYPES, renderSVG, renderMarkdown, injectBetweenMarkers } from '../src/index.js';

const HELP = `upstream-card: the pull requests you got merged into other people's projects

Usage: upstream-card --user <login> [options]

  --user <login>          GitHub user (required unless --from-json is given)
  --svg <file>            write the SVG card here (default: upstream-card.svg)
  --theme auto|dark|light card theme; auto follows the viewer's setting (default: auto)
  --title <text>          card heading
  --top <n>               projects on the card (default: 6)
  --exclude <list>        comma-separated owners or owner/repo to leave out (--exclude-orgs is the same)
  --min-stars <n>         leave out projects with fewer stars
  --exclude-forks         leave out projects that are themselves forks
  --since <YYYY-MM-DD>    only PRs merged on or after this date (UTC); reviewed PRs: opened on or after it
  --types <list>          merged, reviewed or merged,reviewed: what to count (default: merged)
  --md <file>             also write a markdown list of every project and PR
  --readme <file>         put the markdown list between <!-- upstream-card:start --> and :end --> in this file
  --json <file>           also write the summary as JSON
  --from-json <file>      render from a saved --json summary instead of calling GitHub (offline; filters still apply)
  --no-stars              leave star counts off, so the card changes only when a merge does
  --dry-run               print what would change; write nothing

Needs a token in GITHUB_TOKEN or GH_TOKEN (the default Actions token works). Only public repositories are counted.
`;

const FLAGS = new Set(['help', 'dry-run', 'exclude-forks', 'no-stars']);
// Every option that takes a value. Anything else is an error: a mistyped --exlude must not publish
// the PRs it was meant to hide.
const VALUES = new Set(['user', 'svg', 'theme', 'title', 'top', 'exclude', 'exclude-orgs', 'min-stars', 'since', 'types', 'md', 'readme', 'json', 'from-json']);

function parse(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h') { a.help = true; continue; }
    if (!k.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
    const name = k.slice(2);
    if (FLAGS.has(name)) { a[name] = true; continue; }
    if (!VALUES.has(name)) throw new Error(`unknown option ${k} (see --help)`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    a[name] = v;
    i++;
  }
  return a;
}

function wholeNumber(v, name, min) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`);
  return n;
}

// --types merged,reviewed -> ['merged', 'reviewed'] (in that order, no repeats).
function parseTypes(v) {
  if (v === undefined) return ['merged'];
  const asked = v.split(',').map((x) => x.trim());
  const bad = asked.find((t) => !TYPES.includes(t));
  if (bad !== undefined) throw new Error(`--types takes ${TYPES.join(', ')} or both separated by a comma, not "${bad}"`);
  return TYPES.filter((t) => asked.includes(t));
}

// The PRs in a saved --json summary, checked for the expected shape.
function loadSaved(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: not a readable JSON file (${e.message})`); }
  if (!Array.isArray(data?.allProjects) || !data.allProjects.every((p) => Array.isArray(p?.prs) && p.prs.every((x) => typeof x?.repo === 'string'))) {
    throw new Error(`${file}: not an upstream-card summary (write one with --json)`);
  }
  return { prs: data.allProjects.flatMap((p) => p.prs), user: data.user, since: data.since || null };
}

// Write only when the content changed, so a scheduled run with nothing new makes no commit.
function put(file, content, dry, log) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (old === content) { log.push(`unchanged ${file}`); return; }
  log.push(`${old === null ? 'create' : 'update'} ${file}`);
  if (!dry) writeFileSync(file, content);
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (a.help || (!a.user && !a['from-json'])) {
    process.stdout.write(HELP);
    return a.help ? 0 : 2;
  }
  const top = a.top ? wholeNumber(a.top, '--top', 1) : 6;
  const minStars = a['min-stars'] ? wholeNumber(a['min-stars'], '--min-stars', 0) : 0;
  // Round-trip the date: V8 rolls 2026-02-30 over to March 2 instead of rejecting it.
  const sinceDate = a.since && new Date(`${a.since}T00:00:00Z`);
  if (a.since && !(/^\d{4}-\d{2}-\d{2}$/.test(a.since) && !Number.isNaN(sinceDate.getTime()) && sinceDate.toISOString().startsWith(a.since))) {
    throw new Error('--since must be a real date like 2026-01-31');
  }
  const types = parseTypes(a.types);
  const exclude = [a.exclude, a['exclude-orgs']].filter(Boolean).join(',').split(',').map((x) => x.trim()).filter(Boolean);
  let prs;
  let savedUser;
  let savedSince = null;
  if (a['from-json']) {
    ({ prs, user: savedUser, since: savedSince } = loadSaved(a['from-json']));
  } else {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    prs = await fetchPRs(a.user, { token, since: a.since, types });
  }
  const summary = summarize(prs, { exclude, minStars, excludeForks: !!a['exclude-forks'], top, types, since: a.since || savedSince });
  const user = a.user || savedUser || '';
  summary.user = user;
  const dry = !!a['dry-run'];
  // Build every output before writing any, so a bad --readme can't leave half the files updated.
  const md = renderMarkdown(summary, { stars: !a['no-stars'] });
  const outputs = [[a.svg || 'upstream-card.svg', renderSVG(summary, { user, theme: a.theme, title: a.title, stars: !a['no-stars'] })]];
  if (a.md) outputs.push([a.md, md]);
  if (a.readme) {
    if (!existsSync(a.readme)) throw new Error(`${a.readme} does not exist`);
    outputs.push([a.readme, injectBetweenMarkers(readFileSync(a.readme, 'utf8'), md)]);
  }
  if (a.json) outputs.push([a.json, JSON.stringify(summary, null, 2) + '\n']);
  const log = [];
  for (const [file, content] of outputs) put(file, content, dry, log);
  process.stderr.write(`upstream-card: ${summary.totalMerged} merged PRs${types.includes('reviewed') ? `, ${summary.totalReviewed} reviewed` : ''} in ${summary.totalProjects} projects${dry ? ' (dry run, nothing written)' : ''}\n${log.map((l) => `  ${l}`).join('\n')}\n`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`upstream-card: ${e.message}\n`);
  process.exit(1);
});
