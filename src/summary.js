// Group merged PRs by project, apply the filters, and rank the projects.

export function summarize(prs, { exclude = [], minStars = 0, excludeForks = false, top = 6 } = {}) {
  const skip = exclude.map((s) => s.toLowerCase());
  const excluded = (pr) => {
    const r = pr.repo.toLowerCase();
    const owner = r.split('/')[0];
    if (skip.some((s) => (s.includes('/') ? r === s : owner === s))) return true;
    if ((pr.stars ?? 0) < minStars) return true;
    return excludeForks && pr.fork;
  };
  // Group by repository id, so a repo renamed between two PRs is still one project.
  const byRepo = new Map();
  for (const pr of prs) {
    if (excluded(pr)) continue;
    const key = pr.repoId ?? pr.repo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(pr);
  }
  const projects = [...byRepo.values()].map((list) => {
    list.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    const first = [...list].sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)))[0];
    return {
      repo: list[0].repo,
      merged: list.length,
      stars: list[0].stars ?? 0,
      language: list[0].language ?? null,
      first: first.mergedAt,
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
