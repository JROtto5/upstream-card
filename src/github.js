// Fetch a user's merged pull requests in other people's public repositories.
// Zero dependencies: Node 20+ global fetch. A token is optional for the search but
// raises the rate limit (60 -> 5,000 requests an hour); GITHUB_TOKEN works in Actions.

const API = 'https://api.github.com';

export function searchQuery(user, { since } = {}) {
  // is:public keeps private work (a day job, client repos) off a public card even when
  // the token can see it. -user: drops the person's own repositories.
  const q = [`author:${user}`, 'is:pr', 'is:merged', 'is:public', `-user:${user}`];
  if (since) q.push(`merged:>=${since}`);
  return q.join(' ');
}

async function getJSON(url, token, fetchImpl) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'upstream-card' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// -> [{ repo, number, title, url, mergedAt }]
export async function fetchMergedPRs(user, { token, since, max = 300, fetchImpl = fetch } = {}) {
  const out = [];
  const q = encodeURIComponent(searchQuery(user, { since }));
  for (let page = 1; out.length < max && page <= 10; page++) {
    const data = await getJSON(`${API}/search/issues?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`, token, fetchImpl);
    for (const it of data.items || []) {
      const repo = it.repository_url.replace(`${API}/repos/`, '');
      out.push({
        repo,
        number: it.number,
        title: it.title,
        url: it.html_url,
        mergedAt: it.pull_request?.merged_at || it.closed_at,
      });
    }
    if (!data.items || data.items.length < 100) break;
  }
  return out.slice(0, max);
}

// -> { "owner/name": { stars, language, description } }; one request per repository.
export async function fetchRepoInfo(repos, { token, fetchImpl = fetch } = {}) {
  const info = {};
  for (const r of repos) {
    try {
      const d = await getJSON(`${API}/repos/${r}`, token, fetchImpl);
      info[r] = { stars: d.stargazers_count ?? 0, language: d.language || null, description: d.description || '' };
    } catch {
      info[r] = { stars: 0, language: null, description: '' };
    }
  }
  return info;
}
