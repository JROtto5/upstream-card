#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchPRs, probe, RateLimitError, summarize, TYPES, checkTypes, renderSVG, renderMarkdown, injectBetweenMarkers } from '../src/index.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
  --cache <file>          remember what GitHub showed here and skip the run when nothing changed (see the README)
  --dry-run               print what would change; write nothing

Needs a token in GITHUB_TOKEN or GH_TOKEN (the default Actions token works). Only public repositories are counted.
`;

const FLAGS = new Set(['help', 'dry-run', 'exclude-forks', 'no-stars']);
// Every option that takes a value. Anything else is an error: a mistyped --exlude must not publish
// the PRs it was meant to hide.
const VALUES = new Set(['user', 'svg', 'theme', 'title', 'top', 'exclude', 'exclude-orgs', 'min-stars', 'since', 'types', 'md', 'readme', 'json', 'from-json', 'cache']);

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
  return checkTypes(asked);
}

// The PRs in a saved --json summary, checked for the expected shape.
function loadSaved(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: not a readable JSON file (${e.message})`); }
  if (!Array.isArray(data?.allProjects) || !data.allProjects.every((p) => Array.isArray(p?.prs) && p.prs.every((x) => typeof x?.repo === 'string'))) {
    throw new Error(`${file}: not an upstream-card summary (write one with --json)`);
  }
  return { prs: data.allProjects.flatMap((p) => p.prs), user: data.user, since: data.since || null, truncated: data.truncated === true };
}

const CACHE_MAX_AGE_MS = 30 * 86400e3; // star counts and renames only show up on a full run, so force one this often

// The saved state, if it is still good: made by this version with these exact options (a changed --top
// or --exclude must redraw the card), recent, and every output file still there. Otherwise null.
function readCache(file, fingerprint, outputs, now) {
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const fresh = now - Date.parse(c?.refreshedAt) < CACHE_MAX_AGE_MS;
  return c?.fingerprint === fingerprint && typeof c.state === 'string' && fresh && outputs.every((f) => existsSync(f)) ? c : null;
}

// Write only when the content changed, so a scheduled run with nothing new makes no commit.
function put(file, content, dry, log) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (old === content) { log.push(`unchanged ${file}`); return; }
  log.push(`${old === null ? 'create' : 'update'} ${file}`);
  if (!dry) writeFileSync(file, content);
}

// Out of API budget: leave every output as it is (nothing is written before the fetch is complete, so
// no half-built card), say so, and succeed, so a scheduled run doesn't go red for a limit that resets
// on its own. If an output doesn't exist yet there is nothing to keep, and that is a failure.
function keepWhatIsThere(e, files) {
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`${e.message}; ${missing.join(', ')} not written yet, so there is nothing to keep. Run again later`);
  const msg = `${e.message}; keeping the existing ${files.join(', ')} unchanged. The next run will refresh them`;
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning title=upstream-card::${msg}\n`);
  process.stderr.write(`upstream-card: ${msg}\n`);
  return 0;
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
  if (a.cache && a['from-json']) throw new Error('--cache is for runs that call GitHub; it does nothing with --from-json');
  const outFiles = [a.svg || 'upstream-card.svg', a.md, a.readme, a.json].filter(Boolean);
  let state = null; // what GitHub shows now, saved at the end
  const fingerprint = a.cache && createHash('sha256').update(JSON.stringify([PKG.version, process.argv.slice(2).filter((x, i, all) => x !== '--dry-run' && x !== '--cache' && all[i - 1] !== '--cache')])).digest('hex');
  if (a.cache) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const saved = readCache(a.cache, fingerprint, outFiles, Date.now());
    try {
      state = await probe(a.user, { token, since: a.since, types });
      if (saved && saved.state === state) {
        process.stderr.write(`upstream-card: nothing changed since the last run (checked with ${types.length} small search${types.length === 1 ? '' : 'es'}); ${outFiles.join(', ')} left as they are\n`);
        return 0;
      }
    } catch (e) {
      // Out of budget already: a full run would only hit the same limit.
      if (e instanceof RateLimitError) return keepWhatIsThere(e, outFiles);
      process.stderr.write(`upstream-card: could not check for changes (${e.message}); doing a full run\n`);
    }
  }
  let prs;
  let savedUser;
  let savedSince = null;
  let savedTruncated = false;
  if (a['from-json']) {
    ({ prs, user: savedUser, since: savedSince, truncated: savedTruncated } = loadSaved(a['from-json']));
  } else {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    try {
      prs = await fetchPRs(a.user, { token, since: a.since, types });
    } catch (e) {
      if (e instanceof RateLimitError) return keepWhatIsThere(e, outFiles);
      throw e;
    }
  }
  const summary = summarize(prs, { exclude, minStars, excludeForks: !!a['exclude-forks'], top, types, since: a.since || savedSince, truncated: !!prs.truncated || savedTruncated });
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
  // Saved last: the state is only good once the files it describes are written.
  if (a.cache && state && !dry) writeFileSync(a.cache, JSON.stringify({ version: 2, fingerprint, state, refreshedAt: new Date().toISOString() }) + '\n');
  process.stderr.write(`upstream-card: ${summary.totalMerged} merged PRs${types.includes('reviewed') ? `, ${summary.totalReviewed} reviewed` : ''} in ${summary.totalProjects} projects${dry ? ' (dry run, nothing written)' : ''}\n${log.map((l) => `  ${l}`).join('\n')}\n`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`upstream-card: ${e.message}\n`);
  process.exit(1);
});
