// Render the summary as an SVG card and as a markdown section.
import { formatStars, kindOf, dateOf } from './summary.js';

const THEMES = {
  dark: { bg: '#0d1117', border: '#30363d', title: '#e6edf3', text: '#c9d1d9', muted: '#8b949e', accent: '#3fb950', bar: '#238636' },
  light: { bg: '#ffffff', border: '#d0d7de', title: '#1f2328', text: '#1f2328', muted: '#656d76', accent: '#1a7f37', bar: '#2da44e' },
};

// GitHub's linguist colours for common languages; anything else is grey.
const LANG = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', 'C++': '#f34b7d', C: '#555555', Rust: '#dea584',
  Go: '#00ADD8', Elixir: '#6e4a7e', Java: '#b07219', Kotlin: '#A97BFF', Ruby: '#701516', Shell: '#89e051',
  Lua: '#000080', 'C#': '#178600', Swift: '#F05138', PHP: '#4F5D95', Zig: '#ec915c', WGSL: '#1a5e9a',
};

export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

// Clip by code point, so an emoji at the boundary isn't cut in half.
function clip(s, n) {
  const chars = Array.from(String(s));
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
}

export function totalsLine(summary, { long = false } = {}) {
  const m = summary.totalMerged;
  const r = summary.totalReviewed ?? 0;
  const p = summary.totalProjects;
  const noun = (n) => (long ? `pull request${n === 1 ? '' : 's'}` : `PR${n === 1 ? '' : 's'}`);
  const projects = `other project${p === 1 ? '' : 's'}`;
  const types = summary.types ?? ['merged'];
  if (!types.includes('merged')) return `${r} ${noun(r)} reviewed in ${p} ${projects}`;
  if (!types.includes('reviewed')) return `${m} ${noun(m)} merged into ${p} ${projects}`;
  return `${m} ${noun(m)} merged, ${r} reviewed, in ${p} ${projects}`;
}

// Colour rules per theme. Plain class rules, not CSS variables: some SVG renderers (librsvg,
// image proxies) ignore var(), and the card would come out black.
function colours(t) {
  return `.h,.count{fill:${t.title}}.sub{fill:${t.accent}}.repo{fill:${t.text}}.muted{fill:${t.muted}}.card{fill:${t.bg};stroke:${t.border}}.bar{fill:${t.bar}}`;
}

// theme: 'auto' follows the viewer's light/dark setting (prefers-color-scheme); 'dark' or 'light' fixes it.
export function renderSVG(summary, { user, theme = 'auto', title, stars = true } = {}) {
  if (!['auto', 'dark', 'light'].includes(theme)) throw new Error(`unknown theme "${theme}": use auto, dark or light`);
  const palette = theme === 'auto'
    ? `${colours(THEMES.light)}\n@media (prefers-color-scheme: dark){${colours(THEMES.dark)}}`
    : colours(theme === 'light' ? THEMES.light : THEMES.dark);
  const rows = summary.projects;
  const W = 495;
  const rowH = 26;
  const top = 78;
  const H = top + Math.max(rows.length, 1) * rowH + 40;
  // The bar counts merged PRs, or reviewed ones when merged isn't shown.
  const byMerged = (summary.types ?? ['merged']).includes('merged');
  const count = (p) => (byMerged ? p.merged : p.reviewed);
  const max = Math.max(1, ...rows.map(count));
  const heading = title || (user ? `${user}'s upstream contributions` : 'Upstream contributions');
  const sub = totalsLine(summary);
  const lines = rows.map((p, i) => {
    const y = top + i * rowH;
    const barW = Math.round((count(p) / max) * 70);
    // A project you only reviewed in has no merged PR to size a bar: say so in words instead.
    const reviewedOnly = byMerged && p.merged === 0;
    const dot = LANG[p.language] || '#8b949e';
    return [
      `<g transform="translate(24,${y})">`,
      `<circle cx="5" cy="-4" r="5" fill="${dot}"/>`,
      `<text x="18" y="0" class="repo">${escapeXml(clip(p.repo, 34))}</text>`,
      stars ? `<text x="300" y="0" class="muted" text-anchor="end">★ ${formatStars(p.stars)}</text>` : '',
      reviewedOnly ? '' : `<rect x="320" y="-11" width="${barW}" height="10" rx="3" class="bar"/>`,
      reviewedOnly ? `<text x="447" y="0" class="muted" text-anchor="end">${p.reviewed} reviewed</text>` : `<text x="447" y="0" class="count" text-anchor="end">${count(p)}</text>`,
      `</g>`,
    ].join('');
  });
  const kinds = (summary.types ?? ['merged']).join(' or ');
  const empty = rows.length ? '' : `<text x="24" y="${top}" class="muted">No ${kinds} pull requests in other public projects yet.</text>`;
  const langs = summary.languages.slice(0, 5).map((l) => l.name).join(' · ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(heading)}: ${escapeXml(sub)}">
<title>${escapeXml(heading)}: ${escapeXml(sub)}</title>
<style>
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.h{font-size:17px;font-weight:600}
.sub,.muted{font-size:12px}
.repo{font-size:13px}
.count{font-size:13px;font-weight:600}
${palette}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" class="card"/>
<text x="24" y="32" class="h">${escapeXml(clip(heading, 48))}</text>
<text x="24" y="52" class="sub">${escapeXml(sub)}</text>
${lines.join('\n')}${empty}
<text x="24" y="${H - 16}" class="muted">${escapeXml(langs)}</text>
</svg>
`;
}

const FIRST = '🌱 first contribution';

export function renderMarkdown(summary, { perProject = 3, stars = true } = {}) {
  const out = [];
  out.push(`**${totalsLine(summary, { long: true })}.**`, '');
  for (const p of summary.allProjects) {
    const meta = [p.language, stars && `★ ${formatStars(p.stars)}`].filter(Boolean).join(' · ');
    const counts = [p.merged && `${p.merged} merged`, p.reviewed && `${p.reviewed} reviewed`].filter(Boolean).join(', ');
    out.push(`- **[${p.repo}](https://github.com/${p.repo})** (${meta}): ${counts}`);
    const badges = !summary.since && !summary.truncated && p.firstPr !== undefined; // see summarize: no badges for a --since slice or a cut fetch
    const isFirst = (pr) => kindOf(pr) === 'merged' && pr.number === p.firstPr;
    const shown = p.prs.slice(0, perProject);
    for (const pr of shown) {
      const when = kindOf(pr) === 'reviewed' ? `reviewed, opened ${dateOf(pr).slice(0, 10)}` : dateOf(pr).slice(0, 10);
      const badge = badges && isFirst(pr) ? ` · ${FIRST}` : '';
      out.push(`  - [${clip(pr.title, 100).replace(/[[\]<>]/g, '')}](${pr.url}) (${when})${badge}`);
    }
    if (p.prs.length > perProject) {
      const hidden = badges && !shown.some(isFirst) ? `, ${p.reviewed ? 'among them' : 'the oldest is'} your ${FIRST} (${String(p.firstMergedAt).slice(0, 10)})` : '';
      out.push(`  - and ${p.prs.length - perProject} more${hidden}`);
    }
  }
  return out.join('\n') + '\n';
}

// Replace the text between two marker comments in a README. With neither marker present, the markers and the
// block are appended at the end; with only one, or in the wrong order, it refuses rather than guess.
export function injectBetweenMarkers(readme, block, name = 'upstream-card') {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = readme.indexOf(start);
  const j = readme.indexOf(end);
  if ((i === -1) !== (j === -1) || (i !== -1 && j < i)) {
    throw new Error(`the README needs both ${start} and ${end}, in that order`);
  }
  if (i === -1) return `${readme.replace(/\n*$/, '\n\n')}${start}\n${block}${end}\n`;
  return readme.slice(0, i + start.length) + '\n' + block + readme.slice(j);
}
