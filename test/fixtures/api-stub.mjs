// Preloaded with `node --import` by the CLI tests: a fake GitHub GraphQL endpoint that logs each call
// in UC_LOG (one line each: "probe" for the --cache check, "graphql" for the full fetch). The probe sees
// the newest PR as updated at UC_UPDATED (UC_UPDATED_REVIEWED for the reviewed search), so changing
// those env vars is "something changed on GitHub". UC_PROBE_STATUS makes the probe fail with that status.
import { appendFileSync } from 'node:fs';
const log = (what) => appendFileSync(process.env.UC_LOG, `${what}\n`);
const headers = { get: () => null };
globalThis.fetch = async (url, opts) => {
  const { query, variables } = JSON.parse(opts.body);
  if (query.includes('updatedAt')) {
    log('probe');
    const status = Number(process.env.UC_PROBE_STATUS || 0);
    if (status === 403) return { ok: false, status, headers: { get: (k) => (k === 'x-ratelimit-remaining' ? '0' : null) }, text: async () => 'API rate limit exceeded' };
    if (status) return { ok: false, status, headers, text: async () => '' };
    const reviewed = variables.q.includes('reviewed-by:');
    const updatedAt = (reviewed ? process.env.UC_UPDATED_REVIEWED : process.env.UC_UPDATED) || '2026-11-01T00:00:00Z';
    return { ok: true, status: 200, headers, json: async () => ({ data: { search: { issueCount: 1, nodes: [{ id: reviewed ? 'PR_r' : 'PR_m', updatedAt }] } } }) };
  }
  log('graphql');
  const repo = { databaseId: 1, nameWithOwner: 'acme/widgets', isPrivate: false, isFork: false, stargazerCount: 10, primaryLanguage: { name: 'Go' }, owner: { login: 'acme' } };
  const data = query.includes('first: 1)')
    ? { search: { issueCount: 1 } }
    : { search: { issueCount: 1, nodes: [{ number: 1, title: 'a', url: 'u', mergedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-30T00:00:00Z', repository: repo }], pageInfo: { hasNextPage: false, endCursor: null } } };
  return { ok: true, status: 200, headers, json: async () => ({ data }) };
};
