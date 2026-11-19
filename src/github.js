// Fetch a user's merged pull requests in other people's public repositories, through
// GitHub's GraphQL search. A token is required (GraphQL has no anonymous access); inside
// Actions the default GITHUB_TOKEN is enough, since only public data is read.

const GRAPHQL = 'https://api.github.com/graphql';
const SEARCH_CAP = 1000; // GitHub search never returns more than this for one query

// type 'merged': PRs the user authored that were merged. type 'reviewed': PRs someone else authored
// that the user reviewed (any state). Merged PRs are dated by merge day; reviewed ones by the day the
// PR was opened, since search has no review date and a PR's last-update date keeps moving.
export function searchQuery(user, { from, to, type = 'merged' } = {}) {
  if (type === 'reviewed') {
    const q = [`reviewed-by:${user}`, 'is:pr', 'is:public', `-author:${user}`, `-user:${user}`, 'sort:updated-desc'];
    if (from && to) q.push(`created:${from}..${to}`);
    else if (from) q.push(`created:>=${from}`);
    else if (to) q.push(`created:<=${to}`);
    return q.join(' ');
  }
  // is:public keeps private work (a day job, client repos) off a public card even when the
  // token can see it. -user: drops the person's own repositories.
  // sort:updated-desc: search cannot sort by merge date, and for merged PRs the last update is
  // nearly always the merge, so inside a window, too, the most recent PRs come first.
  const q = [`author:${user}`, 'is:pr', 'is:merged', 'is:public', `-user:${user}`, 'sort:updated-desc'];
  if (from && to) q.push(`merged:${from}..${to}`);
  else if (from) q.push(`merged:>=${from}`);
  else if (to) q.push(`merged:<=${to}`);
  return q.join(' ');
}

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url mergedAt createdAt
      repository { databaseId nameWithOwner isPrivate isFork stargazerCount primaryLanguage { name } owner { login } }
    } }
  }
}`;

const COUNT = `query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`;

// Thrown when GitHub says the API budget is used up (primary limit) or asks us to back off (secondary
// limit), so the caller can keep what it already has instead of failing the run.
export class RateLimitError extends Error {
  constructor(message, resetAt = null) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt; // Date, or null when GitHub didn't say
  }
}

function rateLimitError(headers) {
  const h = (k) => headers?.get?.(k) ?? null;
  const reset = Number(h('x-ratelimit-reset'));
  const retry = Number(h('retry-after'));
  // retry-after (a secondary limit) wins: those replies still carry the primary window's reset, which can be an hour off.
  const resetAt = retry > 0 ? new Date(Date.now() + retry * 1000) : reset > 0 ? new Date(reset * 1000) : null;
  return new RateLimitError(`GitHub API rate limit reached${resetAt ? ` (resets ${resetAt.toISOString()})` : ''}`, resetAt);
}

// A 429 is always a rate limit. A 403 is one when GitHub says so: no budget left, a retry-after, or
// "rate limit" in the message (the secondary limit). Any other 403 (a bad token) stays an error.
function isRateLimited(res, body) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers?.get?.('x-ratelimit-remaining') === '0' || res.headers?.get?.('retry-after') != null || /rate limit/i.test(body);
}

export async function graphql(query, variables, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('a GitHub token is required: set GITHUB_TOKEN or GH_TOKEN (the default Actions token works)');
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'upstream-card' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (isRateLimited(res, body)) throw rateLimitError(res.headers);
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // GraphQL reports the primary limit as a 200 with an error of this type.
  if (data.errors?.some((e) => e.type === 'RATE_LIMITED')) throw rateLimitError(res.headers);
  if (data.errors?.length) throw new Error(`GitHub API: ${data.errors.map((e) => e.message).join('; ')}`);
  return data.data;
}

const day = (d) => d.toISOString().slice(0, 10);

// Date windows [from, to] (YYYY-MM-DD, inclusive) each holding at most SEARCH_CAP results,
// found by halving any window the search says is too big.
export async function windows(user, from, to, opts) {
  const { search } = await graphql(COUNT, { q: searchQuery(user, { from, to, type: opts.type }) }, opts);
  if (search.issueCount <= SEARCH_CAP) return [[from, to]];
  if (from === to) {
    (opts.warn || console.error)(`upstream-card: ${search.issueCount} ${opts.type || 'merged'} PRs on ${from} alone; GitHub search returns at most ${SEARCH_CAP}, so that day is incomplete`);
    return [[from, to]];
  }
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  const mid = new Date(a + Math.floor((b - a) / 86400e3 / 2) * 86400e3);
  const next = new Date(mid.getTime() + 86400e3);
  return [...(await windows(user, from, day(mid), opts)), ...(await windows(user, day(next), to, opts))];
}

// -> [{ repo, repoId, number, title, url, mergedAt, stars, language, owner, fork }]
// Windows are read newest first, so if `max` is reached it's the oldest PRs that are left out (with a warning).
export function fetchMergedPRs(user, opts = {}) {
  return fetchKind(user, 'merged', opts);
}

// types: 'merged' (default), 'reviewed', or both. Reviewed entries carry kind: 'reviewed' and createdAt
// instead of mergedAt; `max` applies to each type on its own.
export async function fetchPRs(user, { types = ['merged'], ...opts } = {}) {
  const out = [];
  for (const type of types) out.push(...(await fetchKind(user, type, opts)));
  return out;
}

async function fetchKind(user, type, { token, since, max = 5000, fetchImpl = fetch, now = new Date(), warn = console.error } = {}) {
  const opts = { token, fetchImpl, warn, type };
  const reviewed = type === 'reviewed';
  const from = since || '2008-01-01'; // GitHub launched in 2008
  const spans = (await windows(user, from, day(now), opts)).reverse();
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (const [a, b] of spans) {
    let after = null;
    do {
      const { search } = await graphql(SEARCH, { q: searchQuery(user, { from: a, to: b, type }), after }, opts);
      for (const n of search.nodes) {
        const r = n?.repository;
        // A deleted repository comes back null; a private one never belongs on a public card.
        if (!(reviewed ? n?.createdAt : n?.mergedAt) || !r || r.isPrivate) continue;
        if (r.owner.login.toLowerCase() === user.toLowerCase()) continue;
        // Window edges and retries could repeat a node; count each PR once.
        const key = `${r.databaseId}#${n.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (out.length >= max) { truncated = true; break; }
        out.push({
          repo: r.nameWithOwner, // current name, so a renamed or transferred repo shows as it is today
          repoId: r.databaseId,
          number: n.number,
          title: n.title,
          url: n.url,
          ...(reviewed ? { kind: 'reviewed', createdAt: n.createdAt } : { mergedAt: n.mergedAt }),
          stars: r.stargazerCount ?? 0,
          language: r.primaryLanguage?.name ?? null,
          owner: r.owner.login,
          fork: !!r.isFork,
        });
      }
      after = search.pageInfo.hasNextPage && !truncated ? search.pageInfo.endCursor : null;
    } while (after);
    if (truncated) break;
  }
  if (truncated) warn(`upstream-card: stopped at ${max} ${type} PRs; older ones are left out`);
  return out;
}
