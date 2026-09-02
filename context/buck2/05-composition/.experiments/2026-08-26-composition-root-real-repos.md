# Composition Root over Real Megarepo Compositions

Date: 2026-08-26 — Host: dev3 — Buck2 2026-04-14-7600cb80 (same binary as the
2026-08-25 cells experiment).

## Question

Does the synthesized composition root work over the REAL repositories
(effect-utils mounted as a member cell with its actual BUCK files; dotfiles
content as the root cell), and what must mr/genie change to produce it?

## Method

A throwaway manifest-driven generator (bun) emitted composition roots for
three shapes: single-member (effect-utils only), two-member (member_b with a
cross-cell dep), and a root cell carrying real dotfiles content (11 targets
across 5 packages). Real effect-utils sources were mounted with a 14-file /
112-line portability diff (label rewrites, see below). Digests were read from
the event log; negative controls included dropping detector coverage,
symlinked mounts, dereferenced capability links, and deleting the member's
own `.buckconfig`.

## Result

- `buck2 targets effect_utils//...` evaluates 35 real targets from the
  composition root; tui-core's real target builds in every root shape.
- tui-core action digest `d2a35da88164a0b14f05744d344dcaefc1bfc730a6e86e6f93
26d796db16d680:142` is identical across single-member, two-member,
  renamed-root, and real-dotfiles-root shapes: root cell name AND content are
  irrelevant to member identity. Hub platform config hashes byte-identical
  everywhere.
- Detector negative control: without `target:effect_utils//...` coverage, a
  member target reached directly gets `cfg=<unspecified>` while the same
  target via a cross-cell dep gets the hub config — two configurations for one
  target (the COMP-R04 trap, reproduced on real content).
- **COMP-A01 falsified:** megarepo materializes `repos/<name>` as ABSOLUTE
  SYMLINKS into the store (verified across ~15 composed worktrees; no
  real-directory mode exists). A symlinked mount builds fine but yields digest
  `8ec90fe5…:142` — a silent cache-namespace split. mr change surface:
  `packages/@overeng/megarepo` `src/lib/sync/member.ts:113` (the only
  materialization primitive, a bare `fs.symlink`), `:300`/`:1003` (non-symlink
  bail), and `src/lib/store-liveness.ts:105-129` (liveness reads
  `readlink repos/*`, so real dirs would break `mr store gc` accounting).
- Dereferencing the capability projection's `/nix/store` symlinks HARD-FAILS
  (`support tool must resolve to an immutable Nix store executable`):
  COMP-R08's relative-only rule is unimplementable as written; `/nix/store`
  absolute targets are content-addressed and host-identical and must be
  admitted.
- Emitting `[cell_aliases] root = <root-repo>` silently retargets a member's
  `root//` references to the composition root (verified); omitting it turns
  the same reference into a loud parse error. The alias must NOT be emitted.
- An empty `toolchains/BUCK` fails prelude rule resolution ("Unknown target
  `genrule`"); the cell needs `system_demo_toolchains()` (dotfiles' checked-in
  content, taken over by the generator).
- Member portability diff (effect-utils): 25 `root//` label sites plus one
  string site (`toolchains/configured.bzl:68`, fails at action time not parse
  time) -> `effect_utils//`; 4 `toolchains//:X` sites -> member-local labels;
  genie-emitted BUCK targets carry no `visibility` and `package_task()`
  cannot forward one — cross-cell consumption is impossible until genie's
  projection emits visibility.
- The member's own `.buckconfig` is byte-for-byte inert under composition
  (deleting it left digests identical; only `[cell_aliases]` is honored and
  the existing ones agree).
- `--isolation-dir` is CLI-only; the projected `.buckconfig` cannot pin it.
  All runs used the default `v2` — consistent by accident.
- cwd deep inside a member resolves to the composition root (COMP-R06 holds
  when the member ships no `.buckroot`; effect-utils ships none — dotfiles is
  the repo that has one). Watchman declared at the root drives cross-cell
  invalidation correctly; the member's `file_watcher` setting is inert.

## Conclusion

The composition-root architecture holds on real content, and the generator is
the cheap half (a working prototype exists). The expensive half is mr:
real-directory materialization is a precondition for any shared cache
namespace, and the generator belongs in mr (which lives inside effect-utils —
no cross-repo handshake) as a third generator beside `vscode.ts` and
`input-discovery.ts`, taking per-member cell name/mount/ignores plus
per-composition hub and isolation-dir facts. Members declare their half in a
genie-projected manifest. Delete effect-utils' `.buckconfig` when the
generator lands so the unsupported bare-checkout shape fails loudly. An
isolation-dir wrapper is required because buckconfig cannot pin it.

## VRS Impact

Falsifies COMP-A01 (now a requirement on mr, COMP-R10); amends COMP-R08
(/nix/store absolute targets admitted); corrects 05-composition spec
(cell_aliases, toolchains cell content, hub platform labels, isolation-dir
wrapper); adds the genie visibility obligation; feeds roadmap Phase 2
sequencing (mr materialization before cache-namespace claims).
