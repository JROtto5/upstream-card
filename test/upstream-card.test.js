import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchQuery, fetchMergedPRs, fetchPRs, windows, summarize, renderSVG, renderMarkdown, injectBetweenMarkers, formatStars, escapeXml, totalsLine } from '../src/index.js';

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

test('pagination past 100 follows the cursor', async () => {
  const r = repo('acme/widgets');
  const page1 = Array.from({ length: 100 }, (_, i) => pr(i, r));
  const f = fakeGraphQL({ count: () => 105, pages: (q, after) => (after ? { nodes: [pr(100, r), pr(101, r)] } : { nodes: page1, next: 'c1' }) });
  const prs = await fetchMergedPRs('octo', { token: 't', fetchImpl: f, now: NOW });
  assert.equal(prs.length, 102);
  assert.equal(f.calls[0].auth, 'Bearer t');
});

test('past 1,000 results the date range is split until each window fits', async () => {
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

test('private, deleted and own repos never leak; a renamed repo is one project', async () => {
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

test('hostile names and titles are escaped and the SVG is well-formed XML', (t) => {
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

test('a second run with nothing new changes nothing', () => {
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

test('no token fails clearly; a token is sent', async () => {
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

test('--since is a UTC date; bad dates are refused', async () => {
  const f = fakeGraphQL({ count: () => 0, pages: () => ({ nodes: [] }) });
  await fetchMergedPRs('octo', { token: 't', fetchImpl: f, since: '2026-11-18', now: NOW });
  assert.ok(f.calls[0].variables.q.includes('merged:2026-11-18..2026-11-18'), 'same-day window includes the day itself');
  for (const bad of ['2026-13-01', '11/18/2026', 'yesterday']) {
    const r = spawnSync('node', [BIN, '--user', 'octo', '--since', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--since must be a real date/);
  }
});

test('dark, light and auto cards match their snapshots', () => {
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

test('the installed bin works through an npm-style symlink with no .js suffix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const link = join(dir, 'upstream-card');
  symlinkSync(BIN, link);
  const r = spawnSync('node', [link, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /upstream-card: the pull requests/);
});

test('--from-json applies the filters and refuses a file that is not a summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  writeFileSync(json, JSON.stringify(summarize(SAMPLE)));
  const r = spawnSync('node', [BIN, '--from-json', json, '--svg', join(dir, 'c.svg'), '--top', '1', '--exclude', 'work,small'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const svg = readFileSync(join(dir, 'c.svg'), 'utf8');
  assert.match(svg, /3 PRs merged into 2 other projects/);
  assert.equal((svg.match(/class="repo"/g) || []).length, 1, '--top 1 shows one row');
  writeFileSync(join(dir, 'bad.json'), '{"hello":1}');
  const bad = spawnSync('node', [BIN, '--from-json', join(dir, 'bad.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not an upstream-card summary/);
  writeFileSync(join(dir, 'bad2.json'), '{"allProjects":[{"prs":[null]}]}');
  assert.match(spawnSync('node', [BIN, '--from-json', join(dir, 'bad2.json')], { encoding: 'utf8' }).stderr, /not an upstream-card summary/);
});

test('a missing --readme fails before any file is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  writeFileSync(json, JSON.stringify(summarize(SAMPLE)));
  const r = spawnSync('node', [BIN, '--from-json', json, '--svg', join(dir, 'c.svg'), '--readme', join(dir, 'nope.md')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  assert.ok(!existsSync(join(dir, 'c.svg')));
});

test('when max is reached the newest PRs are kept and a warning says so', async () => {
  // Two windows (the count says the whole range is too big); each holds 3 PRs.
  const r = repo('acme/widgets');
  const f = fakeGraphQL({
    count: (q) => (q.includes('2008-01-01..2026-11-18') ? 2000 : 3),
    pages: (q) => ({ nodes: q.includes('..2026-11-18') && !q.includes('2008-01-01') ? [pr(10, r, '2026-11-10T00:00:00Z'), pr(11, r, '2026-11-11T00:00:00Z'), pr(12, r, '2026-11-12T00:00:00Z')] : [pr(1, r, '2010-01-01T00:00:00Z'), pr(2, r, '2010-01-02T00:00:00Z'), pr(3, r, '2010-01-03T00:00:00Z')] }),
  });
  const warnings = [];
  const prs = await fetchMergedPRs('octo', { token: 't', fetchImpl: f, now: NOW, max: 4, warn: (m) => warnings.push(m) });
  assert.equal(prs.length, 4);
  assert.deepEqual(prs.slice(0, 3).map((p) => p.number), [10, 11, 12], 'the newest window is read first');
  assert.match(warnings.join(), /stopped at 4 merged PRs; older ones are left out/);
});

test('a single day over the search cap is reported, not silently cut', async () => {
  const f = fakeGraphQL({ count: () => 1500, pages: () => ({ nodes: [] }) });
  const warnings = [];
  const w = await windows('octo', '2026-11-18', '2026-11-18', { token: 't', fetchImpl: f, warn: (m) => warnings.push(m) });
  assert.deepEqual(w, [['2026-11-18', '2026-11-18']]);
  assert.match(warnings.join(), /1500 merged PRs on 2026-11-18 alone/);
});

test('injectBetweenMarkers refuses a lone or reversed marker', () => {
  assert.throws(() => injectBetweenMarkers('a\n<!-- upstream-card:start -->\nb\n', 'x\n'), /needs both/);
  assert.throws(() => injectBetweenMarkers('<!-- upstream-card:end -->\n<!-- upstream-card:start -->\n', 'x\n'), /in that order/);
});

test('one PR reads as singular on the card and in markdown; no user gives a neutral heading', () => {
  const s = summarize([SAMPLE[0]]);
  assert.equal(totalsLine(s), '1 PR merged into 1 other project');
  assert.ok(renderMarkdown(s).startsWith('**1 pull request merged into 1 other project.**'));
  assert.ok(renderSVG(s).includes('>Upstream contributions<'));
  assert.ok(!renderSVG(s).includes('undefined'));
});

test('long titles are clipped without splitting an emoji', () => {
  const title = 'a'.repeat(98) + '🎉🎉🎉';
  const md = renderMarkdown(summarize([{ ...SAMPLE[0], title }]));
  assert.ok(!md.includes('�') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(md), 'no lone surrogate');
  assert.ok(md.includes('🎉…'));
});

test('a mistyped option is an error, not silently ignored', () => {
  const r = spawnSync('node', [BIN, '--user', 'octo', '--exlude', 'work'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --exlude/);
});

test('--since refuses dates that do not exist', () => {
  for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29']) {
    const r = spawnSync('node', [BIN, '--user', 'octo', '--since', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /real date/);
  }
});

test('--no-stars keeps star counts off, so a star change does not change the output', () => {
  const a = summarize(SAMPLE);
  const b = summarize(SAMPLE.map((p) => ({ ...p, stars: p.stars + 1 })));
  assert.notEqual(renderSVG(a, { user: 'o' }), renderSVG(b, { user: 'o' }));
  assert.equal(renderSVG(a, { user: 'o', stars: false }), renderSVG(b, { user: 'o', stars: false }));
  assert.equal(renderMarkdown(a, { stars: false }), renderMarkdown(b, { stars: false }));
  assert.ok(!renderSVG(a, { user: 'o', stars: false }).includes('★'));
});

test('the README workflow refreshes weekly and on demand, and examples/upstream-card.yml is the same file', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/```yaml\n(name: upstream-card[\s\S]*?)```/)?.[1];
  assert.ok(block, 'README has the workflow example');
  const cron = block.match(/cron: "([^"]+)"/)?.[1].split(' ');
  assert.equal(cron?.length, 5, 'one five-field cron line');
  const [min, hour, dom, mon, dow] = cron;
  assert.ok(/^\d+$/.test(min) && /^\d+$/.test(hour), 'a fixed time of day');
  assert.ok(dom === '*' && mon === '*' && /^[0-6]$/.test(dow), `weekly (one day of the week), got "${cron.join(' ')}"`);
  assert.match(block, /\n  workflow_dispatch:/);
  assert.equal(readFileSync(new URL('../examples/upstream-card.yml', import.meta.url), 'utf8'), block);
});

test('the PR that was your first merge in a project is badged in the list, wherever it falls in the order', () => {
  const md = renderMarkdown(summarize(SAMPLE, { exclude: ['work'] }));
  const line = (n) => md.split('\n').find((l) => l.includes(`(u${n})`));
  assert.ok(line(1).endsWith('(2026-11-01) · 🌱 first contribution'), 'acme/widgets: #1 merged before #2');
  assert.ok(!line(2).includes('first contribution'));
  assert.ok(line(3).includes('first contribution'), 'a project with one merged PR: that PR is the first');
  assert.equal(summarize([...SAMPLE].reverse()).projects.find((p) => p.repo === 'acme/widgets').firstPr, 1, 'input order does not matter');
});

test('a first contribution that is past the per-project cap is named on the "and N more" line', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ repo: 'acme/widgets', repoId: 1, number: i + 1, title: `t${i}`, url: `u${i}`, mergedAt: `2026-11-0${i + 1}`, stars: 10, language: 'Go' }));
  const md = renderMarkdown(summarize(many), { perProject: 3 });
  assert.ok(md.includes('and 2 more, the oldest is your 🌱 first contribution (2026-11-01)'), md);
  assert.equal((md.match(/first contribution/g) || []).length, 1, 'once per project');
  assert.ok(!renderMarkdown(summarize(many), { perProject: 5 }).includes('the oldest is your'), 'shown on its own line when it is listed');
});

test('--since means no first-contribution badges: the oldest PR in the slice is not known to be the first', () => {
  const s = summarize(SAMPLE, { since: '2026-11-01' });
  assert.equal(s.since, '2026-11-01');
  assert.ok(!renderMarkdown(s).includes('first contribution'));
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  const run = (...args) => spawnSync('node', [BIN, '--from-json', json, '--svg', join(dir, 'c.svg'), '--md', join(dir, 'u.md'), ...args], { encoding: 'utf8' });
  writeFileSync(json, JSON.stringify(summarize(SAMPLE)));
  assert.equal(run().status, 0);
  assert.match(readFileSync(join(dir, 'u.md'), 'utf8'), /first contribution/);
  writeFileSync(json, JSON.stringify(summarize(SAMPLE, { since: '2026-11-01' })));
  assert.equal(run().status, 0);
  assert.ok(!readFileSync(join(dir, 'u.md'), 'utf8').includes('first contribution'), 'a slice saved with --since stays badge-free offline');
});

// --types: merged (default) and reviewed
const REVIEWED = [
  { repo: 'acme/widgets', repoId: 1, number: 20, title: 'review me', url: 'u20', kind: 'reviewed', createdAt: '2026-10-20T00:00:00Z', stars: 10, language: 'Go' },
  { repo: 'big/engine', repoId: 2, number: 21, title: 'also', url: 'u21', kind: 'reviewed', createdAt: '2026-10-21T00:00:00Z', stars: 9000, language: 'C++' },
  { repo: 'only/reviewed', repoId: 5, number: 22, title: 'just a review', url: 'u22', kind: 'reviewed', createdAt: '2026-10-22T00:00:00Z', stars: 7, language: 'Rust' },
];

test('the reviewed search finds other people\'s public PRs you reviewed, dated by when they were opened', () => {
  const q = searchQuery('octo', { type: 'reviewed', from: '2026-01-01', to: '2026-02-01' });
  for (const part of ['reviewed-by:octo', 'is:pr', 'is:public', '-author:octo', '-user:octo', 'created:2026-01-01..2026-02-01']) assert.ok(q.includes(part), part);
  assert.ok(!q.includes('is:merged') && !q.includes('merged:'));
  assert.ok(searchQuery('octo', { type: 'reviewed', from: '2026-01-01' }).includes('created:>=2026-01-01'));
  assert.ok(searchQuery('octo').includes('author:octo') && searchQuery('octo').includes('is:merged'), 'merged stays the default');
});

test('fetchPRs reads merged and reviewed PRs with the right queries and drops private, deleted and own repos', async () => {
  const pub = repo('acme/widgets', { id: 1 });
  const priv = repo('work/secret', { id: 8, priv: true });
  const mine = repo('octo/thing', { id: 9 });
  const f = fakeGraphQL({
    count: () => 1,
    pages: (q) => ({
      nodes: q.includes('reviewed-by:')
        ? [{ ...pr(20, pub), createdAt: '2026-10-20T00:00:00Z' }, { ...pr(21, priv), createdAt: '2026-10-21T00:00:00Z' }, { ...pr(22, null), createdAt: '2026-10-22T00:00:00Z' }, { ...pr(23, mine), createdAt: '2026-10-23T00:00:00Z' }, pr(24, pub)]
        : [pr(1, pub)],
    }),
  });
  const prs = await fetchPRs('octo', { token: 't', fetchImpl: f, now: NOW, types: ['merged', 'reviewed'] });
  assert.deepEqual(prs.map((p) => [p.number, p.kind ?? 'merged']), [[1, 'merged'], [20, 'reviewed']]);
  assert.equal(prs[1].createdAt, '2026-10-20T00:00:00Z');
  assert.equal(prs[1].mergedAt, undefined);
  const searched = f.calls.map((c) => c.variables.q);
  assert.ok(searched.some((q) => q.includes('reviewed-by:octo')) && searched.some((q) => q.includes('is:merged')));
});

test('without types, no reviewed search is ever sent', async () => {
  const r = repo('acme/widgets');
  const f = fakeGraphQL({ count: () => 1, pages: () => ({ nodes: [pr(1, r)] }) });
  await fetchMergedPRs('octo', { token: 't', fetchImpl: f, now: NOW });
  await fetchPRs('octo', { token: 't', fetchImpl: f, now: NOW });
  assert.ok(f.calls.length > 0);
  for (const c of f.calls) assert.ok(!c.variables.q.includes('reviewed-by:'), c.variables.q);
});

test('max applies to each type on its own', async () => {
  const r = repo('acme/widgets');
  const f = fakeGraphQL({
    count: () => 3,
    pages: (q) => ({ nodes: [1, 2, 3].map((n) => ({ ...pr(n + (q.includes('reviewed-by:') ? 100 : 0), r), createdAt: '2026-10-01T00:00:00Z' })) }),
  });
  const warnings = [];
  const prs = await fetchPRs('octo', { token: 't', fetchImpl: f, now: NOW, max: 2, types: ['merged', 'reviewed'], warn: (m) => warnings.push(m) });
  assert.equal(prs.filter((p) => p.kind === 'reviewed').length, 2);
  assert.equal(prs.filter((p) => !p.kind).length, 2);
  assert.match(warnings.join('\n'), /stopped at 2 merged PRs/);
  assert.match(warnings.join('\n'), /stopped at 2 reviewed PRs/);
});

test('summarize counts only the asked-for types; the default ignores reviewed PRs', () => {
  const all = [...SAMPLE, ...REVIEWED];
  assert.deepEqual(summarize(all, { exclude: ['work'] }), summarize(SAMPLE, { exclude: ['work'] }), 'default output is unchanged by reviewed entries');
  const r = summarize(all, { types: ['reviewed'] });
  assert.equal(r.totalMerged, 0);
  assert.equal(r.totalReviewed, 3);
  assert.equal(r.totalProjects, 3);
  assert.deepEqual(r.languages.map((l) => [l.name, l.prs]).sort(), [['C++', 1], ['Go', 1], ['Rust', 1]]);
  const both = summarize(all, { types: ['merged', 'reviewed'], exclude: ['work'] });
  assert.equal(both.totalMerged, 4);
  assert.equal(both.totalReviewed, 3);
  assert.equal(both.totalProjects, 4);
  const widgets = both.projects.find((p) => p.repo === 'acme/widgets');
  assert.equal(widgets.merged, 2);
  assert.equal(widgets.reviewed, 1);
  assert.equal(widgets.prs.length, 3);
  assert.equal(both.projects.at(-1).repo, 'only/reviewed', 'a project you only reviewed in ranks after those with merges');
  assert.equal(summarize(all, { types: ['reviewed'], minStars: 100 }).totalProjects, 1, 'filters apply to reviewed PRs too');
});

test('totals read right for merged, reviewed and both', () => {
  const all = [...SAMPLE, ...REVIEWED];
  assert.equal(totalsLine(summarize(all, { exclude: ['work'] })), '4 PRs merged into 3 other projects');
  assert.equal(totalsLine(summarize(all, { types: ['reviewed'] })), '3 PRs reviewed in 3 other projects');
  assert.equal(totalsLine(summarize(all, { types: ['merged', 'reviewed'], exclude: ['work'] })), '4 PRs merged, 3 reviewed, in 4 other projects');
  assert.equal(totalsLine(summarize([REVIEWED[0]], { types: ['reviewed'] }), { long: true }), '1 pull request reviewed in 1 other project');
});

test('the card and list show reviewed PRs and stay well-formed', (t) => {
  const all = [...SAMPLE, ...REVIEWED];
  const reviewedOnly = summarize(all, { types: ['reviewed'] });
  const svg = renderSVG(reviewedOnly, { user: 'octo' });
  assert.ok(svg.includes('3 PRs reviewed in 3 other projects'));
  assert.equal((svg.match(/class="bar"/g) || []).length, 3, 'a bar per project');
  const both = summarize(all, { types: ['merged', 'reviewed'], exclude: ['work'] });
  const svgBoth = renderSVG(both, { user: 'octo' });
  assert.ok(svgBoth.includes('1 reviewed</text>'), 'a project with only reviews says so in words');
  assert.equal((svgBoth.match(/class="bar"/g) || []).length, 3, 'and gets no bar');
  assert.ok(!svg.includes('undefined') && !svgBoth.includes('undefined'));
  assert.ok(renderSVG(summarize([], { types: ['reviewed'] })).includes('No reviewed pull requests'));
  assert.ok(renderSVG(summarize([], { types: ['merged', 'reviewed'] })).includes('No merged or reviewed pull requests'));
  const md = renderMarkdown(both);
  assert.ok(md.startsWith('**4 pull requests merged, 3 reviewed, in 4 other projects.**'));
  assert.ok(md.includes('): 2 merged, 1 reviewed'), md);
  assert.ok(md.includes('): 1 reviewed\n'));
  assert.ok(md.includes('[review me](u20) (reviewed, opened 2026-10-20)'));
  assert.ok(md.includes('[a](u1) (2026-11-01)'), 'merged PRs keep their plain date');
  const xmllint = spawnSync('xmllint', ['--version']);
  if (xmllint.error) return t.skip('xmllint not installed');
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  writeFileSync(join(dir, 'c.svg'), svgBoth);
  execFileSync('xmllint', ['--noout', join(dir, 'c.svg')]);
});

test('--types: validated, applied to a saved summary, and passed by the Action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const json = join(dir, 's.json');
  writeFileSync(json, JSON.stringify(summarize([...SAMPLE, ...REVIEWED], { types: ['merged', 'reviewed'] })));
  const run = (...args) => spawnSync('node', [BIN, '--from-json', json, '--svg', join(dir, 'c.svg'), ...args], { encoding: 'utf8' });
  const r = run('--types', 'reviewed');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'c.svg'), 'utf8'), /3 PRs reviewed in 3 other projects/);
  assert.match(r.stderr, /0 merged PRs, 3 reviewed in 3 projects/);
  assert.match(run('--types', 'reviewed,merged', '--exclude', 'work').stderr, /4 merged PRs, 3 reviewed in 4 projects/);
  assert.match(run().stderr, /5 merged PRs in 4 projects/, 'no --types: merged only, same line as before');
  for (const bad of ['review', 'merged,', '', 'all']) {
    const e = run('--types', bad);
    assert.equal(e.status, 1, JSON.stringify(bad));
    assert.match(e.stderr, /--types takes merged, reviewed/);
  }
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, /\n  types:\n/);
  assert.match(action, /UC_TYPES: \$\{\{ inputs\.types \}\}/);
  assert.match(action, /--types "\$UC_TYPES"/);
});

test('a reviewed PR is never a first contribution, even when it is the oldest in the project', () => {
  const s = summarize([...SAMPLE, ...REVIEWED], { exclude: ['work'], types: ['merged', 'reviewed'] });
  assert.equal(s.allProjects.find((p) => p.repo === 'acme/widgets').firstPr, 1, '#20 (reviewed) is older but not a merge');
  assert.equal(s.allProjects.find((p) => p.repo === 'only/reviewed').firstPr, undefined);
  const md = renderMarkdown(s);
  const line = (u) => md.split('\n').find((l) => l.includes(`(${u})`));
  assert.ok(line('u1').endsWith('· 🌱 first contribution'));
  for (const u of ['u20', 'u21', 'u22']) assert.ok(!line(u).includes('first contribution'), u);
  const capped = renderMarkdown(s, { perProject: 1 });
  assert.ok(capped.includes('and 2 more, among them your 🌱 first contribution (2026-11-01)'), capped);
});

test('reviewed PRs are windowed with the reviewed query, and an over-full day says "reviewed"', async () => {
  // 1,500 reviewed PRs over the whole range, none merged: only the reviewed count may drive the split.
  const f = fakeGraphQL({ count: (q) => (q.includes('reviewed-by:') ? (q.includes('2008-01-01..2026-11-18') ? 1500 : 600) : 0), pages: () => ({ nodes: [] }) });
  const w = await windows('octo', '2008-01-01', '2026-11-18', { token: 't', fetchImpl: f, type: 'reviewed' });
  assert.ok(w.length > 1, 'split');
  assert.ok(f.calls.every((c) => c.variables.q.includes('reviewed-by:octo') && c.variables.q.includes('created:')));
  const warnings = [];
  await windows('octo', '2026-11-18', '2026-11-18', { token: 't', fetchImpl: fakeGraphQL({ count: () => 1500, pages: () => ({ nodes: [] }) }), type: 'reviewed', warn: (m) => warnings.push(m) });
  assert.match(warnings.join(), /1500 reviewed PRs on 2026-11-18 alone/);
});
