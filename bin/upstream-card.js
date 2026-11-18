#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchMergedPRs, fetchRepoInfo, summarize, renderSVG, renderMarkdown, injectBetweenMarkers } from '../src/index.js';

const HELP = `upstream-card: the pull requests you got merged into other people's projects

Usage: upstream-card --user <login> [options]

  --user <login>        GitHub user (required)
  --svg <file>          write the SVG card here (default: upstream-card.svg)
  --theme dark|light    card theme (default: dark)
  --title <text>        card heading
  --top <n>             projects on the card (default: 6)
  --exclude <list>      comma-separated owners or owner/repo to leave out
  --since <YYYY-MM-DD>  only PRs merged on or after this date
  --md <file>           also write a markdown list of every project and PR
  --readme <file>       put the markdown list between <!-- upstream-card:start --> and :end --> in this file
  --json <file>         also write the raw summary as JSON
  --from-json <file>    render from a saved JSON summary instead of calling GitHub (offline)

A token in GITHUB_TOKEN or GH_TOKEN raises the API rate limit. Only public repositories are counted.
`;

function parse(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') a.help = true;
    else if (k.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      a[k.slice(2)] = v;
      i++;
    } else throw new Error(`unexpected argument: ${k}`);
  }
  return a;
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (a.help || (!a.user && !a['from-json'])) {
    process.stdout.write(HELP);
    return a.help ? 0 : 2;
  }
  const top = a.top ? Number(a.top) : 6;
  if (!Number.isInteger(top) || top < 1) throw new Error('--top must be a positive whole number');
  let summary;
  if (a['from-json']) {
    summary = JSON.parse(readFileSync(a['from-json'], 'utf8'));
  } else {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const prs = await fetchMergedPRs(a.user, { token, since: a.since });
    const exclude = (a.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
    const repos = [...new Set(prs.map((p) => p.repo))];
    const info = await fetchRepoInfo(repos, { token });
    summary = summarize(prs, info, { exclude, top });
  }
  const user = a.user || summary.user || 'you';
  summary.user = user;
  writeFileSync(a.svg || 'upstream-card.svg', renderSVG(summary, { user, theme: a.theme, title: a.title }));
  const md = renderMarkdown(summary);
  if (a.md) writeFileSync(a.md, md);
  if (a.readme) writeFileSync(a.readme, injectBetweenMarkers(readFileSync(a.readme, 'utf8'), md));
  if (a.json) writeFileSync(a.json, JSON.stringify(summary, null, 2) + '\n');
  process.stderr.write(`upstream-card: ${summary.totalMerged} merged PRs in ${summary.totalProjects} projects\n`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`upstream-card: ${e.message}\n`);
  process.exit(1);
});
