# Experiment 0007 — vite build: profile-lane reuse, no structured stats

**Method:** vite 8.0.16 (Rolldown-based, node 24) on a throwaway project.
Probed `--profile`, `--manifest`, `--ssrManifest`, `-d`, and the node-invocation
path against the existing node-cpuprofile lane.

**Result:**
- No first-class OTEL.
- `vite build --profile` writes a standard V8 `vite-profile-0.cpuprofile` on
  **normal exit** (no SIGINT). Passes the existing `validate_cpuprofile_bytes`.
  But `--profile` is **undocumented** (not in `--help`).
- **The profile is already obtainable today with zero new code:** invoking vite
  as a node child under the existing adapter —
  `otel-scrape --adapter node-cpuprofile --cas-root … -- node <vite>/bin/vite.js build`
  (argv0 = `node`) — injects `NODE_OPTIONS=--cpu-prof …` and links the profile.
  Verified (547 nodes / 127 samples to a run-scoped dir). A dedicated vite adapter
  would only add the `vite`-shim case (argv0 = `vite`, profile lands in CWD),
  needing a new CWD pre/post-snapshot + glob + cleanup discovery lane.
- **Structured stats do not qualify (R08):** `--manifest`/`--ssrManifest` are
  path-keyed asset maps with no durations or sizes; chunk sizes appear only in the
  human stdout table; `-d` is debug-log text. No `--metafile`/`--stats`. Rolldown
  per-chunk data lives only in the programmatic JS `output` object, behind no CLI
  flag.

**Conclusion:** deferred profile-lane candidate. Today's answer for a real need is
the node-cpuprofile invocation above. A first-class `vite` adapter is justified
only once `vite build` is on a hot path (it is not in this repo — only one example
app builds with vite; elsewhere vite is transitive under vitest/storybook). No
phase/transform spans (no declared source), no size metrics. If ever built: inject
`--profile`, add a CWD-glob discovery lane, reuse the CAS profile-link lane
unchanged.
