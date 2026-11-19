// Preloaded with `node --import` by the CLI tests: replaces fetch with a canned GitHub reply, so the
// real bin runs end to end without the network. UC_STUB picks the reply.
const mode = process.env.UC_STUB;
const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
globalThis.fetch = async () => {
  if (mode === 'limit-403') return { ok: false, status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000' }), text: async () => 'API rate limit exceeded' };
  if (mode === 'limit-429') return { ok: false, status: 429, headers: headers({ 'retry-after': '60' }), text: async () => '' };
  if (mode === 'limit-graphql') return { ok: true, status: 200, headers: headers({}), json: async () => ({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }) };
  if (mode === 'bad-token') return { ok: false, status: 403, headers: headers({}), text: async () => 'Resource not accessible by integration' };
  throw new Error(`unknown UC_STUB ${mode}`);
};
