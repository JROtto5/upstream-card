# Changelog

## 0.2.0 (2026-11-19)

- `--types merged,reviewed` (Action: `types`): also count PRs by others that you reviewed, in public repos you don't own. Off by default (#9).
- 🌱 first-contribution badges in the markdown list (#12). A reviewed PR is never badged.
- Rate limits: when the API budget runs out, the last card, list and README block are kept, a notice is printed, and the run exits 0. `RateLimitError` is exported for library use (#10).
- `--cache <file>` (Action: `cache`): one small search per type, and the full fetch is skipped when nothing changed since the last run (#13).
- The README and example workflow run weekly, with a Run workflow button (#11).

Default output is unchanged except for the new badges. Saved `--json` summaries from 0.1.0 still load.

## 0.1.0 (2026-11-18)

First release.
