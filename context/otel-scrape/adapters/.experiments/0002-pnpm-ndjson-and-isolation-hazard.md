# Experiment 0002 — pnpm --reporter=ndjson source + isolation hazard

**Hypothesis:** pnpm exposes a declared machine-readable phase source suitable
for a phase-lane adapter (ADP-R01), without debug-log parsing.

**Method:** pnpm 11.8.0. Probed `--reporter={ndjson,append-only,default,silent}`
and `--json` on a throwaway `is-odd@3.0.1` project with `--ignore-workspace` and
an out-of-workspace `--store-dir`. Cold install vs warm `--frozen-lockfile`.

**Result:** `--reporter=ndjson` is the only machine-readable install source —
bunyan NDJSON on stdout (stderr empty), events keyed by `name`. Clean phase
lifecycle from `pnpm:stage`:

```json
{"time":...,"name":"pnpm:stage","stage":"resolution_started"}
{"time":...,"name":"pnpm:progress","status":"resolved"}
{"time":...,"name":"pnpm:stats","removed":0}
```

Cold 2-pkg sequence: `resolution_started +0 → resolution_done +618ms →
importing_started +619 → importing_done +664ms`; progress
`{resolved:2, fetched:2, imported:2}`; stats `{removed:0}` then `{added:2}`.
Warm `--frozen-lockfile` (up-to-date): ~5 lines, no stage/progress/stats.
Overhead vs default reporter: within noise (~300ms frozen either way).

**Conclusion:** phase-lane adapter-worthwhile; value confined to `pnpm:install`.
The flag is stable; per-event payloads (`@pnpm/core-loggers`) are de-facto
(DQ-pnpm-1). Confirms-and-refines the parent audit's "no per-diagnostic source"
— that holds; this is a separate phase lane.

## Isolation hazard (ADP-R07)

pnpm walks **up** to the workspace-root `pnpm-workspace.yaml`. An early probe run
inside the repo tree purged the repo's root `node_modules` and fetched the full
~2GB / 603-pkg closure into an orphan repo-root `store/`. Git-worktree isolation
does **not** contain this: `node_modules` and `.devenv` are gitignored and live
outside the worktree checkout.

**Recovery (verified):** delete the orphan repo-root `store/`; the virtual store
`.devenv/pnpm-store-pure-v1/v11/links` was intact, so `pnpm install
--frozen-lockfile --offline` relinked in ~1.3s. Health confirmed:
`effect@3.21.4` resolves from packages, `links/` = 49, no tracked-file or
lockfile churn.

**Rule:** always audit pnpm with `--ignore-workspace` (or fully outside the
repo) plus an out-of-workspace `--store-dir`. Filed as agent-tooling friction.
