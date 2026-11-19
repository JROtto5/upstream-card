// Group merged PRs by project, apply the filters, and rank the projects.

export const TYPES = ['merged', 'reviewed'];

// ['reviewed', 'merged', 'merged'] -> ['merged', 'reviewed']: TYPES order, no repeats. Anything else
// throws, since an unknown type would otherwise be searched as merged and a string iterated by letter.
export function checkTypes(types) {
  if (!Array.isArray(types) || types.length === 0) throw new TypeError(`types must be a non-empty array of ${TYPES.join(', ')}`);
  const bad = types.find((t) => !TYPES.includes(t));
  if (bad !== undefined) throw new TypeError(`types takes ${TYPES.join(', ')}, not ${JSON.stringify(bad)}`);
  return TYPES.filter((t) => types.includes(t));
}

// The kind of a PR entry; entries saved before --types existed have none and are merged.
export const kindOf = (pr) => pr.kind ?? 'merged';
// The date a PR is shown and sorted by: merge date, or for a reviewed PR the day it was opened.
export const dateOf = (pr) => String(kindOf(pr) === 'reviewed' ? pr.createdAt : pr.mergedAt);

export function summarize(prs, { exclude = [], minStars = 0, excludeForks = false, top = 6, since = null, types = ['merged'] } = {}) {
  types = checkTypes(types);
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
    if (!types.includes(kindOf(pr)) || excluded(pr)) continue;
    const key = pr.repoId ?? pr.repo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(pr);
  }
  const projects = [...byRepo.values()].map((list) => {
    list.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    const first = [...list].sort((a, b) => dateOf(a).localeCompare(dateOf(b)))[0];
    const firstMerge = list.filter((pr) => kindOf(pr) === 'merged').sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)))[0];
    const reviewed = list.filter((pr) => kindOf(pr) === 'reviewed').length;
    return {
      repo: list[0].repo,
      merged: list.length - reviewed,
      reviewed,
      stars: list[0].stars ?? 0,
      language: list[0].language ?? null,
      first: dateOf(first),
      // The PR that was your first merge here (only trustworthy without `since`); a reviewed PR
      // is never a first contribution, so a project you only reviewed in has none.
      firstPr: firstMerge?.number,
      firstMergedAt: firstMerge?.mergedAt,
      last: dateOf(list[0]),
      prs: list,
    };
  });
  // Most merges first, then most reviews, then the bigger project, then the most recent.
  projects.sort((a, b) => b.merged - a.merged || b.reviewed - a.reviewed || b.stars - a.stars || String(b.last).localeCompare(String(a.last)));
  const languages = new Map();
  const both = types.includes('reviewed');
  for (const p of projects) if (p.language) languages.set(p.language, (languages.get(p.language) || 0) + p.merged + p.reviewed);
  return {
    // With --since the oldest PR in view isn't necessarily your first there, so no first-contribution badges.
    since,
    types: TYPES.filter((t) => types.includes(t)),
    totalMerged: projects.reduce((n, p) => n + p.merged, 0),
    totalReviewed: projects.reduce((n, p) => n + p.reviewed, 0),
    totalProjects: projects.length,
    // `merged` is what it was before --types; with reviews on, the count covers both kinds.
    languages: [...languages.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, [both ? 'prs' : 'merged']: n })),
    projects: projects.slice(0, top),
    allProjects: projects,
  };
}

export function formatStars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}
