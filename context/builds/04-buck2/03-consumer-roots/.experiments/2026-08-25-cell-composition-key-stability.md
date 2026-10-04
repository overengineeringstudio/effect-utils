# Cell composition and action-key stability

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), Buck2 `2026-04-14-7600cb80`

## Question

Do megarepo members composed as Buck2 cells share action identities with the
same member built standalone — so one shared cache serves both shapes — and
what discipline is required to keep the keys stable?

## Method

- A real two-member composition: `member-a` ("effect-utils" shape, a TS lib
  target) consumed by a root-cell target in a "dotfiles"-shaped composition
  via a cross-cell dep (`deps = ["effect_utils//lib:lib"]`).
- Action digests were read from the Buck2 event log
  (`buck2 log show` → `ActionExecution … action_digest`), not inferred from
  hit percentages.
- Cache claims ran against a live localhost bazel-remote; each direction wiped
  local state (`buck2 kill` + `rm -rf buck-out`) before rebuilding.
- A same-project wipe-and-rebuild control produced 100% hits, so any miss
  elsewhere is a real digest difference.
- Each key-splitting variable was isolated in its own project variant with
  everything else held byte-identical.

## Result

GREEN:

- Cross-cell deps and cross-cell `load("@effect_utils//:defs.bzl", …)` work.
  Cells are declared in the ROOT `.buckconfig` only; the member cell needs no
  nested `.buckconfig`/`.buckroot` (verified deleted; digest unchanged).
- Standalone (single-member composition root) vs composed: identical digest
  `4b88750ca344…febef:142`, remote cache hit in BOTH directions.
- Invalidation propagates across cells: member edit re-runs member + dependent;
  root-only edit re-runs the dependent only; revert = cache hit. Watchman
  detected cross-cell edits on a warm daemon.
- Directory inputs containing RELATIVE symlinks (pnpm forest shape) are
  key-safe: digest `8aff2701c1e9e615…ecd4` in both shapes, remote hit.
- Root cell NAME, presence of other members/targets: irrelevant to keys.

RED — each splits the cache namespace (digest pairs from isolated variants):

| Variable                                                                | Digest pair                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| Member at project root vs at `repos/effect-utils`                       | `50c6be9c…` vs `4b88750c…`                        |
| Mount path `repos/…` vs `vendor/…`                                      | `94989331…` vs `b074a1f8…`                        |
| Member cell name `effect_utils` vs `eu`                                 | `94989331…` vs `0407b667…`                        |
| Platform LABEL `bp//:default` vs `bp//:alt`, byte-identical definitions | cfg hash `e854d5f441eacc35` vs `939af97d43c12ea1` |
| Cell mounted via absolute symlink vs real dir                           | `94989331…` vs `136c8dcc…`                        |
| Absolute vs relative symlink target inside an input forest              | `867d7a47…` vs `eabf09b6…`                        |

Mechanism: source artifacts render project-relative in action argv
(`lib/src/a.ts` vs `repos/effect-utils/lib/src/a.ts`) and outputs render as
`buck-out/<isolation-dir>/art/<cell>/<confighash>/…`, so mount path, cell name,
config-hash-bearing platform label, and isolation dir all enter the digest.
A bare checkout built as its own project root is therefore a cache island:
"standalone" must itself be a synthesized single-member composition root.

Traps:

- A relative symlink as a cell root is a hard failure ("Invalid symlink …
  expected a normalized path"); an absolute one silently splits keys.
- A member shipping `.buckroot`: running Buck2 with cwd inside the member
  silently builds it as a separate project (second `buck-out`, no shared keys).
- `[parser] target_platform_detector_spec` covering only the root cell gives a
  directly-built member target `cfg=<unspecified>` while the same target via a
  dep gets the platform config — two digests for one target.
- The member's nested `[cell_aliases]` IS honored in composition (nested
  `[cells]` is ignored); a member declaring `root = effect_utils` fails
  composition parsing.
- Per-worktree toolchain paths in argv (e.g. `.devenv/profile/bin/tsgo`) break
  keys on their own; tools must be `/nix/store` paths.

Working root `.buckconfig` shape (what genie projects): `[cells]` root +
`prelude = prelude` + `none`/`toolchains` + one line per member at
`repos/<name>`; `[cell_aliases]` root alias + prelude aliases;
`[external_cells] prelude = bundled`; detector spec and
`[build] execution_platforms` pointing at hub-owned labels
(`effect_utils//platforms:default`); `[buck2]` SHA256 +
`default_allow_cache_upload`; `[buck2_re_client]` at the shared endpoint; a
`.buckroot` at the composition root only; empty `none/BUCK`, `toolchains/BUCK`.

Untested: prelude files as action inputs under `external_cells`, multi-level
member nesting, remote execution.

## Conclusion

Cells-for-source-deps is adopted (decision 0014) with normative discipline:
one canonical mount path and cell name per member, hub-owned shared platform
labels, fixed isolation dir, real-directory mounts, relative symlinks only,
no member `.buckroot`, full detector coverage, `/nix/store` tool paths, and
every build — including single-repo CI and external standalone builds — run
from a synthesized composition root.

## VRS Impact

Decides [decision 0014](../../.decisions/0014-megarepo-cell-composition.md)
and grounds every key-stability requirement in
[05-composition](../requirements.md) (COMP-R01 through COMP-R08): canonical
mounts and cell names, root-only declarations, shared platform labels, fixed
isolation dir, real directories, and the synthesized-root-everywhere rule.
