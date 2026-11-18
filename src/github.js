// Fetch a user's merged pull requests in other people's public repositories, through
// GitHub's GraphQL search. A token is required (GraphQL has no anonymous access); inside
// Actions the default GITHUB_TOKEN is enough, since only public data is read.

const GRAPHQL = 'https://api.github.com/graphql';
const SEARCH_CAP = 1000; // GitHub search never returns more than this for one query

export function searchQuery(user, { from, to } = {}) {
  // is:public keeps private work (a day job, client repos) off a public card even when the
  // token can see it. -user: drops the person's own repositories.
  const q = [`author:${user}`, 'is:pr', 'is:merged', 'is:public', `-user:${user}`];
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
      number title url mergedAt
      repository { databaseId nameWithOwner isPrivate isFork stargazerCount primaryLanguage { name } owner { login } }
    } }
  }
}`;

const COUNT = `query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`;

export async function graphql(query, variables, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('a GitHub token is required: set GITHUB_TOKEN or GH_TOKEN (the default Actions token works)');
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'upstream-card' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.errors?.length) throw new Error(`GitHub API: ${data.errors.map((e) => e.message).join('; ')}`);
  return data.data;
}

const day = (d) => d.toISOString().slice(0, 10);

// Date windows [from, to] (YYYY-MM-DD, inclusive) each holding at most SEARCH_CAP results,
// found by halving any window the search says is too big.
export async function windows(user, from, to, opts) {
  const { search } = await graphql(COUNT, { q: searchQuery(user, { from, to }) }, opts);
  if (search.issueCount <= SEARCH_CAP || from === to) return [[from, to]];
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  const mid = new Date(a + Math.floor((b - a) / 86400e3 / 2) * 86400e3);
  const next = new Date(mid.getTime() + 86400e3);
  return [...(await windows(user, from, day(mid), opts)), ...(await windows(user, day(next), to, opts))];
}

// -> [{ repo, repoId, number, title, url, mergedAt, stars, language, owner, fork }]
export async function fetchMergedPRs(user, { token, since, max = 5000, fetchImpl = fetch, now = new Date() } = {}) {
  const opts = { token, fetchImpl };
  const from = since || '2008-01-01'; // GitHub launched in 2008
  const spans = await windows(user, from, day(now), opts);
  const out = [];
  for (const [a, b] of spans) {
    let after = null;
    do {
      const { search } = await graphql(SEARCH, { q: searchQuery(user, { from: a, to: b }), after }, opts);
      for (const n of search.nodes) {
        const r = n?.repository;
        // A deleted repository comes back null; a private one never belongs on a public card.
        if (!n?.mergedAt || !r || r.isPrivate) continue;
        if (r.owner.login.toLowerCase() === user.toLowerCase()) continue;
        out.push({
          repo: r.nameWithOwner, // current name, so a renamed or transferred repo shows as it is today
          repoId: r.databaseId,
          number: n.number,
          title: n.title,
          url: n.url,
          mergedAt: n.mergedAt,
          stars: r.stargazerCount ?? 0,
          language: r.primaryLanguage?.name ?? null,
          owner: r.owner.login,
          fork: !!r.isFork,
        });
      }
      after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
    } while (after && out.length < max);
    if (out.length >= max) break;
  }
  // The same PR can't appear twice, but window edges and retries could repeat a node.
  const seen = new Set();
  return out.filter((p) => {
    const k = `${p.repoId}#${p.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, max);
}
