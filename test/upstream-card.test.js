import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchQuery, fetchMergedPRs, fetchRepoInfo, summarize, renderSVG, renderMarkdown, injectBetweenMarkers, formatStars, escapeXml } from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/search.json', import.meta.url)));

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    for (const [pat, body] of routes) {
      if (url.includes(pat)) return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

test('the search counts only merged PRs in other people\'s public repos', () => {
  const q = searchQuery('octo');
  for (const part of ['author:octo', 'is:pr', 'is:merged', 'is:public', '-user:octo']) assert.ok(q.includes(part), part);
  assert.ok(searchQuery('octo', { since: '2026-01-01' }).includes('merged:>=2026-01-01'));
});

test('fetchMergedPRs maps search items and sends the token', async () => {
  const f = fakeFetch([['/search/issues', fixture]]);
  const prs = await fetchMergedPRs('octo', { token: 't0k', fetchImpl: f });
  assert.equal(prs.length, 4);
  assert.deepEqual(prs[0], { repo: 'acme/widgets', number: 12, title: 'Fix the off-by-one in paging', url: 'https://github.com/acme/widgets/pull/12', mergedAt: '2026-11-10T10:00:00Z' });
  assert.equal(f.calls[0].opts.headers.authorization, 'Bearer t0k');
});

test('fetchMergedPRs pages until a short page', async () => {
  let n = 0;
  const full = { items: Array.from({ length: 100 }, (_, i) => ({ ...fixture.items[0], number: i })) };
  const f = async () => ({ ok: true, json: async () => (++n === 1 ? full : { items: fixture.items.slice(0, 2) }) });
  const prs = await fetchMergedPRs('octo', { fetchImpl: f });
  assert.equal(prs.length, 102);
  assert.equal(n, 2);
});

test('an API error names the status', async () => {
  const f = async () => ({ ok: false, status: 403, text: async () => 'rate limited' });
  await assert.rejects(fetchMergedPRs('octo', { fetchImpl: f }), /GitHub API 403/);
});

test('fetchRepoInfo survives a missing repo', async () => {
  const f = fakeFetch([['/repos/acme/widgets', { stargazers_count: 1520, language: 'Go', description: 'w' }]]);
  const info = await fetchRepoInfo(['acme/widgets', 'gone/away'], { fetchImpl: f });
  assert.deepEqual(info['acme/widgets'], { stars: 1520, language: 'Go', description: 'w' });
  assert.deepEqual(info['gone/away'], { stars: 0, language: null, description: '' });
});

const PRS = [
  { repo: 'acme/widgets', number: 1, title: 'a', url: 'u1', mergedAt: '2026-11-01T00:00:00Z' },
  { repo: 'acme/widgets', number: 2, title: 'b', url: 'u2', mergedAt: '2026-11-05T00:00:00Z' },
  { repo: 'big/engine', number: 3, title: 'c', url: 'u3', mergedAt: '2026-10-01T00:00:00Z' },
  { repo: 'small/tool', number: 4, title: 'd', url: 'u4', mergedAt: '2026-11-07T00:00:00Z' },
  { repo: 'work/secret', number: 5, title: 'e', url: 'u5', mergedAt: '2026-11-08T00:00:00Z' },
];
const INFO = { 'acme/widgets': { stars: 10, language: 'Go' }, 'big/engine': { stars: 9000, language: 'C++' }, 'small/tool': { stars: 5, language: 'Go' } };

test('summarize ranks by merges, then stars, and honours exclusions', () => {
  const s = summarize(PRS, INFO, { exclude: ['work'] });
  assert.equal(s.totalMerged, 4);
  assert.equal(s.totalProjects, 3);
  assert.deepEqual(s.projects.map((p) => p.repo), ['acme/widgets', 'big/engine', 'small/tool']);
  assert.equal(s.projects[0].prs[0].number, 2, 'newest PR first');
  assert.deepEqual(s.languages, [{ name: 'Go', merged: 3 }, { name: 'C++', merged: 1 }]);
  assert.equal(summarize(PRS, INFO, { exclude: ['big/engine', 'work'] }).totalProjects, 2);
  assert.equal(summarize(PRS, INFO, { top: 1 }).projects.length, 1);
});

test('formatStars', () => {
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1520), '1.5k');
  assert.equal(formatStars(2000), '2k');
  assert.equal(formatStars(18500), '19k');
});

test('the SVG escapes text and states the totals', () => {
  const s = summarize([...PRS, { repo: 'x/<script>', number: 9, title: 't', url: 'u', mergedAt: '2026-01-01' }], INFO, { exclude: ['work'] });
  const svg = renderSVG(s, { user: 'octo', theme: 'light' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('5 PRs merged into 4 other projects'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('x/&lt;script&gt;'));
  assert.equal(escapeXml(`"&'`), '&quot;&amp;&apos;');
});

test('an empty history still renders', () => {
  const svg = renderSVG(summarize([], {}), { user: 'new' });
  assert.ok(svg.includes('0 PRs merged into 0 other projects'));
  assert.ok(svg.includes('No merged pull requests'));
});

test('markdown lists every project and caps PRs per project', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ repo: 'acme/widgets', number: i, title: `[t] ${i}`, url: `u${i}`, mergedAt: `2026-11-0${i + 1}` }));
  const md = renderMarkdown(summarize(many, INFO), { perProject: 3 });
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
