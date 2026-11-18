// Group merged PRs by project and rank the projects.

export function summarize(prs, info = {}, { exclude = [], top = 6 } = {}) {
  const skip = exclude.map((s) => s.toLowerCase());
  const excluded = (repo) => {
    const r = repo.toLowerCase();
    const owner = r.split('/')[0];
    return skip.some((s) => (s.includes('/') ? r === s : owner === s));
  };
  const byRepo = new Map();
  for (const pr of prs) {
    if (excluded(pr.repo)) continue;
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo).push(pr);
  }
  const projects = [...byRepo.entries()].map(([repo, list]) => {
    list.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    const i = info[repo] || {};
    return {
      repo,
      merged: list.length,
      stars: i.stars ?? 0,
      language: i.language ?? null,
      last: list[0].mergedAt,
      prs: list,
    };
  });
  // Most merges first, then the bigger project, then the most recent.
  projects.sort((a, b) => b.merged - a.merged || b.stars - a.stars || String(b.last).localeCompare(String(a.last)));
  const languages = new Map();
  for (const p of projects) if (p.language) languages.set(p.language, (languages.get(p.language) || 0) + p.merged);
  return {
    totalMerged: projects.reduce((n, p) => n + p.merged, 0),
    totalProjects: projects.length,
    languages: [...languages.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, merged: n })),
    projects: projects.slice(0, top),
    allProjects: projects,
  };
}

export function formatStars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}
