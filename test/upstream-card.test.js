import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchQuery, fetchMergedPRs, windows, summarize, renderSVG, renderMarkdown, injectBetweenMarkers, formatStars, escapeXml } from '../src/index.js';

const BIN = fileURLToPath(new URL('../bin/upstream-card.js', import.meta.url));
const SNAP = (name) => new URL(`./snapshots/${name}`, import.meta.url);

function repo(name, { id = 1, stars = 10, lang = 'Go', priv = false, fork = false } = {}) {
  return { databaseId: id, nameWithOwner: name, isPrivate: priv, isFork: fork, stargazerCount: stars, primaryLanguage: lang ? { name: lang } : null, owner: { login: name.split('/')[0] } };
}
function pr(n, r, mergedAt = '2026-11-01T00:00:00Z', title = `PR ${n}`) {
  return { number: n, title, url: `https://github.com/${r?.nameWithOwner ?? 'gone/gone'}/pull/${n}`, mergedAt, repository: r };
}

// A fake GraphQL endpoint: count(q) -> issueCount for COUNT queries; pages(q, after) -> {nodes, next}.
function fakeGraphQL({ count = () => 0, pages }) {
  const calls = [];
  const fn = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    calls.push({ variables, auth: opts.headers.authorization });
    let data;
    if (query.includes('first: 1)')) data = { search: { issueCount: count(variables.q) } };
    else {
      const p = pages(variables.q, variables.after);
      data = { search: { issueCount: p.nodes.length, nodes: p.nodes, pageInfo: { hasNextPage: !!p.next, endCursor: p.next ?? null } } };
    }
    return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date('2026-11-18T12:00:00Z');

test('the search counts only merged PRs in other people\'s public repos', () => {
  const q = searchQuery('octo');
  for (const part of ['author:octo', 'is:pr', 'is:merged', 'is:public', '-user:octo']) assert.ok(q.includes(part), part);
  assert.ok(searchQuery('octo', { from: '2026-01-01', to: '2026-02-01' }).includes('merged:2026-01-01..2026-02-01'));
});

test('checklist 1: pagination past 100 follows the cursor', async () => {
  const r = repo('acme/widgets');
  const page1 = Array.from({ length: 100 }, (_, i) => pr(i, r));
  const f = fakeGraphQL({ count: () => 105, pages: (q, after) => (after ? { nodes: [pr(100, r), pr(101, r)] } : { nodes: page1, next: 'c1' }) });
  const prs = await fetchMergedPRs('octo', { token: 't', fetchImpl: f, now: NOW });
  assert.equal(prs.length, 102);
  assert.equal(f.calls[0].auth, 'Bearer t');
});

test('checklist 1: past 1,000 results the date range is split until each window fits', async () => {
  // 1,600 results spread evenly over 2008-01-01..2026-11-18: every window over 1,000 must be halved.
  const span = (q) => {
    const m = q.match(/merged:(\S+)\.\.(\S+)/);
    const days = (Date.parse(m[2]) - Date.parse(m[1])) / 86400e3 + 1;
    return Math.round((days / 6897) * 1600);
  };
  const f = fakeGraphQL({ count: span, pages: () => ({ nodes: [] }) });
  const w = await windows('octo', '2008-01-01', '2026-11-18', { token: 't', fetchImpl: f });
  assert.ok(w.length >= 2, 'split at least once');
  assert.equal(w[0][0], '2008-01-01');
  assert.equal(w.at(-1)[1], '2026-11-18');
  for (let i = 1; i < w.length; i++) {
    assert.equal(Date.parse(w[i][0]) - Date.parse(w[i - 1][1]), 86400e3, 'windows are contiguous, no gap or overlap');
  }
  for (const [a, b] of w) assert.ok(span(`merged:${a}..${b}`) <= 1000);
});

test('checklist 2: private, deleted and own repos never leak; a renamed repo is one project', async () => {
  const pub = repo('acme/widgets', { id: 7 });
  const renamed = repo('acme/gadgets', { id: 7 }); // same repository id: renamed after the earlier PR
  const priv = repo('work/secret', { id: 8, priv: true });
  const mine = repo('octo/thing', { id: 9 });
  const nodes = [pr(1, pub, '2026-11-01T00:00:00Z'), pr(2, renamed, '2026-11-05T00:00:00Z'), pr(3, priv), pr(4, null), pr(5, mine), { ...pr(6, pub), mergedAt: null }];
  const f = fakeGraphQL({ count: () => nodes.length, pages: () => ({ nodes }) });
  const prs = await fetchMergedPRs('Octo', { token: 't', fetchImpl: f, now: NOW });
  assert.deepEqual(prs.map((p) => p.number), [1, 2]);
  const s = summarize(prs);
  assert.equal(s.totalProjects, 1);
  assert.equal(s.projects[0].merged, 2);
  const svg = renderSVG(s, { user: 'octo' });
  assert.ok(!svg.includes('secret') && !svg.includes('octo/thing'));
});

test('checklist 3: hostile names and titles are escaped and the SVG is well-formed XML', (t) => {
  const evil = repo('x/"><script>alert(1)</script>', { lang: 'Go' });
  const prs = [{ repo: evil.nameWithOwner, repoId: 1, number: 1, title: '</svg><img src=x onerror=alert(1)> & ]] [[', url: 'u', mergedAt: '2026-11-01', stars: 3, language: 'Go' }];
  const s = summarize(prs);
  const svg = renderSVG(s, { user: 'o"&<>' , title: '<b>&' });
  assert.ok(!svg.includes('<script>'));
  assert.ok(!/<b>/.test(svg));
  assert.equal(escapeXml(`"&'<>`), '&quot;&amp;&apos;&lt;&gt;');
  const md = renderMarkdown(s);
  assert.ok(!md.includes('<img'), 'markdown titles lose angle brackets');
  const xmllint = spawnSync('xmllint', ['--version']);
  if (xmllint.error) return t.skip('xmllint not installed');
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  writeFileSync(join(dir, 'c.svg'), svg);
  execFileSync('xmllint', ['--noout', join(dir, 'c.svg')]);
});

test('checklist 4: a second run with nothing new changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  writeFileSync(json, JSON.stringify(summarize(SAMPLE)));
  writeFileSync(join(dir, 'README.md'), 'hi\n<!-- upstream-card:start -->\n<!-- upstream-card:end -->\nbye\n');
  const run = () => spawnSync('node', [BIN, '--from-json', json, '--user', 'octo', '--svg', join(dir, 'c.svg'), '--readme', join(dir, 'README.md')], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /create .*c\.svg/);
  assert.match(first.stderr, /update .*README\.md/);
  const readme1 = readFileSync(join(dir, 'README.md'), 'utf8');
  const second = run();
  assert.match(second.stderr, /unchanged .*c\.svg/);
  assert.match(second.stderr, /unchanged .*README\.md/);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), readme1);
  assert.ok(readme1.startsWith('hi\n') && readme1.endsWith('bye\n'));
});

test('dry run writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  writeFileSync(json, JSON.stringify(summarize(SAMPLE)));
  const r = spawnSync('node', [BIN, '--from-json', json, '--svg', join(dir, 'c.svg'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /dry run, nothing written/);
  assert.ok(!existsSync(join(dir, 'c.svg')));
});

test('checklist 5: no token fails clearly; a token is sent', async () => {
  await assert.rejects(fetchMergedPRs('octo', { fetchImpl: fakeGraphQL({ pages: () => ({ nodes: [] }) }) }), /GitHub token is required/);
  const r = spawnSync('node', [BIN, '--user', 'octo', '--svg', '/dev/null'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_TOKEN or GH_TOKEN/);
});

test('an API error names the status, and GraphQL errors surface', async () => {
  const bad = async () => ({ ok: false, status: 403, text: async () => 'rate limited' });
  await assert.rejects(fetchMergedPRs('octo', { token: 't', fetchImpl: bad, now: NOW }), /GitHub API 403/);
  const err = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Something broke' }] }) });
  await assert.rejects(fetchMergedPRs('octo', { token: 't', fetchImpl: err, now: NOW }), /Something broke/);
});

test('checklist 6: --since is a UTC date; bad dates are refused', async () => {
  const f = fakeGraphQL({ count: () => 0, pages: () => ({ nodes: [] }) });
  await fetchMergedPRs('octo', { token: 't', fetchImpl: f, since: '2026-11-18', now: NOW });
  assert.ok(f.calls[0].variables.q.includes('merged:2026-11-18..2026-11-18'), 'same-day window includes the day itself');
  for (const bad of ['2026-13-01', '11/18/2026', 'yesterday']) {
    const r = spawnSync('node', [BIN, '--user', 'octo', '--since', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--since must be a date/);
  }
});

test('checklist 7: dark, light and auto cards match their snapshots', () => {
  const s = summarize(SAMPLE, { exclude: ['work'] });
  for (const theme of ['dark', 'light', 'auto']) {
    const svg = renderSVG(s, { user: 'octo', theme });
    const file = SNAP(`sample-${theme}.svg`);
    if (process.env.UPDATE_SNAPSHOTS) writeFileSync(file, svg);
    assert.equal(svg, readFileSync(file, 'utf8'), `${theme} snapshot (UPDATE_SNAPSHOTS=1 to refresh)`);
  }
  assert.ok(renderSVG(s, { user: 'o', theme: 'auto' }).includes('prefers-color-scheme: dark'));
  assert.throws(() => renderSVG(s, { theme: 'neon' }), /unknown theme/);
});

const SAMPLE = [
  { repo: 'acme/widgets', repoId: 1, number: 1, title: 'a', url: 'u1', mergedAt: '2026-11-01T00:00:00Z', stars: 10, language: 'Go' },
  { repo: 'acme/widgets', repoId: 1, number: 2, title: 'b', url: 'u2', mergedAt: '2026-11-05T00:00:00Z', stars: 10, language: 'Go' },
  { repo: 'big/engine', repoId: 2, number: 3, title: 'c', url: 'u3', mergedAt: '2026-10-01T00:00:00Z', stars: 9000, language: 'C++' },
  { repo: 'small/tool', repoId: 3, number: 4, title: 'd', url: 'u4', mergedAt: '2026-11-07T00:00:00Z', stars: 5, language: 'Go', fork: true },
  { repo: 'work/secret', repoId: 4, number: 5, title: 'e', url: 'u5', mergedAt: '2026-11-08T00:00:00Z', stars: 50, language: 'Go' },
];

test('summarize ranks by merges then stars, and applies every filter', () => {
  const s = summarize(SAMPLE, { exclude: ['work'] });
  assert.equal(s.totalMerged, 4);
  assert.deepEqual(s.projects.map((p) => p.repo), ['acme/widgets', 'big/engine', 'small/tool']);
  assert.equal(s.projects[0].prs[0].number, 2, 'newest PR first');
  assert.equal(s.projects[0].first, '2026-11-01T00:00:00Z');
  assert.deepEqual(s.languages, [{ name: 'Go', merged: 3 }, { name: 'C++', merged: 1 }]);
  assert.equal(summarize(SAMPLE, { exclude: ['big/engine', 'WORK'] }).totalProjects, 2, 'case-insensitive');
  assert.equal(summarize(SAMPLE, { minStars: 11 }).totalProjects, 2);
  assert.equal(summarize(SAMPLE, { excludeForks: true, exclude: ['work'] }).totalProjects, 2);
  assert.equal(summarize(SAMPLE, { top: 1 }).projects.length, 1);
});

test('formatStars', () => {
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1520), '1.5k');
  assert.equal(formatStars(2000), '2k');
  assert.equal(formatStars(18500), '19k');
});

test('an empty history still renders', () => {
  const svg = renderSVG(summarize([]), { user: 'new' });
  assert.ok(svg.includes('0 PRs merged into 0 other projects'));
  assert.ok(svg.includes('No merged pull requests'));
});

test('markdown lists every project and caps PRs per project', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ repo: 'acme/widgets', repoId: 1, number: i, title: `[t] ${i}`, url: `u${i}`, mergedAt: `2026-11-0${i + 1}`, stars: 10, language: 'Go' }));
  const md = renderMarkdown(summarize(many), { perProject: 3 });
  assert.ok(md.includes('**[acme/widgets](https://github.com/acme/widgets)** (Go · ★ 10): 5 merged'));
  assert.ok(md.includes('and 2 more'));
  assert.ok(!md.includes('[[t]'), 'brackets in titles do not break links');
});

test('injectBetweenMarkers replaces only the marked block', () => {
  const readme = 'intro\n<!-- upstream-card:start -->\nold\n<!-- upstream-card:end -->\noutro\n';
  assert.equal(injectBetweenMarkers(readme, 'new\n'), 'intro\n<!-- upstream-card:start -->\nnew\n<!-- upstream-card:end -->\noutro\n');
  const appended = injectBetweenMarkers('intro\n', 'new\n');
  assert.ok(appended.endsWith('<!-- upstream-card:start -->\nnew\n<!-- upstream-card:end -->\n'));
});
