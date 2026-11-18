// Render the summary as an SVG card and as a markdown section.
import { formatStars } from './summary.js';

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
  const p = summary.totalProjects;
  const prs = long ? `pull request${m === 1 ? '' : 's'}` : `PR${m === 1 ? '' : 's'}`;
  return `${m} ${prs} merged into ${p} other project${p === 1 ? '' : 's'}`;
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
  const max = Math.max(1, ...rows.map((p) => p.merged));
  const heading = title || (user ? `${user}'s upstream contributions` : 'Upstream contributions');
  const sub = totalsLine(summary);
  const lines = rows.map((p, i) => {
    const y = top + i * rowH;
    const barW = Math.round((p.merged / max) * 70);
    const dot = LANG[p.language] || '#8b949e';
    return [
      `<g transform="translate(24,${y})">`,
      `<circle cx="5" cy="-4" r="5" fill="${dot}"/>`,
      `<text x="18" y="0" class="repo">${escapeXml(clip(p.repo, 34))}</text>`,
      stars ? `<text x="300" y="0" class="muted" text-anchor="end">★ ${formatStars(p.stars)}</text>` : '',
      `<rect x="320" y="-11" width="${barW}" height="10" rx="3" class="bar"/>`,
      `<text x="447" y="0" class="count" text-anchor="end">${p.merged}</text>`,
      `</g>`,
    ].join('');
  });
  const empty = rows.length ? '' : `<text x="24" y="${top}" class="muted">No merged pull requests in other public projects yet.</text>`;
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

export function renderMarkdown(summary, { perProject = 3, stars = true } = {}) {
  const out = [];
  out.push(`**${totalsLine(summary, { long: true })}.**`, '');
  for (const p of summary.allProjects) {
    const meta = [p.language, stars && `★ ${formatStars(p.stars)}`].filter(Boolean).join(' · ');
    out.push(`- **[${p.repo}](https://github.com/${p.repo})** (${meta}): ${p.merged} merged`);
    for (const pr of p.prs.slice(0, perProject)) {
      out.push(`  - [${clip(pr.title, 100).replace(/[[\]<>]/g, '')}](${pr.url}) (${String(pr.mergedAt).slice(0, 10)})`);
    }
    if (p.prs.length > perProject) out.push(`  - and ${p.prs.length - perProject} more`);
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
