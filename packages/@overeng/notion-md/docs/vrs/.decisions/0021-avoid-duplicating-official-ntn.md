# Avoid duplicating functionality already in the official `ntn` CLI

We do **not** build a command in our own Notion tooling (`@overeng/notion-md`
`cat`/`put`/`edit`/`sync`/`status`/`plan`, and the `@overeng/notion-cli`
`notion` umbrella) that merely re-implements something the official `ntn` CLI
already does, **unless we have a documented clear reason** recorded here. `ntn`
is the baseline; anything we add on the same surface must earn its place with a
safety, fidelity, library-reuse, or scope property `ntn` does not provide. When
the clear reason disappears (e.g. `ntn` grows the guard), the duplicate becomes
a candidate for deprecation toward `ntn`.

`ntn` is Notion's official, **closed-source** CLI (a prebuilt Rust binary,
vendored through a Nix flake). Because it is closed-source we cannot extend it;
the only ways to add a behavior are to wrap it or to re-implement the surface.
Re-implementing is a standing cost (drift, maintenance, divergent semantics), so
it must be justified per command.

## Why

Two recurring failure modes motivate the principle:

1. **Silent surface drift.** A duplicated command tracks a moving upstream. If
   we forget _why_ we duplicated it, we cannot tell an intentional divergence
   from an accidental one, and we pay maintenance for a behavior the user could
   get upstream.
2. **False safety.** `ntn`'s page-edit path is an **unguarded last-writer-wins**
   `replace_content`: its only guard is `--allow-deleting-content` (which gates
   deletion of child pages / databases). It has **no base-hash / optimistic
   concurrency / conflict detection**, and it is **blind to the R38
   silent-data-loss class**: `ntn`'s `unknown_block_ids` only flags blocks that
   render as a literal `<unknown>`. The R38-lossy blocks (`child_database`,
   `table_of_contents`, `synced_block`, `breadcrumb`, `bookmark`, `embed`,
   `link_preview`, `link_to_page`, and a body `child_page`) render to _plausible_
   Markdown and are **silently destroyed** on a `replace_content` round-trip —
   the defect tracked in
   [effect-utils#785](https://github.com/overengineeringstudio/effect-utils/issues/785).
   Our editor verbs **refuse** such a page up front (exit 3) via the curated
   not-round-trip-safe type set in `@overeng/notion-core` `body-fidelity.ts`
   (decisions [0016](./0016-refuse-lossy-pages.md),
   [0017](./0017-edit-is-an-ephemeral-file-engine-session.md)).

Writing the principle down means every overlap is a _recorded_ decision, not an
accident, and the duplicates carry an explicit, falsifiable clear reason.

## The duplication audit

Surfaces mapped against the official CLI as observed in **`ntn` 0.17.0**
(`pages get|create|edit|trash`, `datasources query|resolve`, `api`,
`files create|get|list`, `login|logout|whoami`, `workers`). The version is
pinned because this table is point-in-time rationale: if a later `ntn` changes a
surface (e.g. adds a guard to `pages edit`), the matching clear reason below must
be re-checked.

| Our command                                      | Closest `ntn` surface                   | Verdict                  | Clear reason / boundary                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put` / `edit` / `notion edit`                   | `ntn pages edit` (incl. `$EDITOR`)      | **KEEP**                 | Guarded base-hash write (refuse-on-drift, exit 7), refuse-lossy/R38 (exit 3), post-push semantic-equivalence verify (exit 9). `ntn pages edit` is the unguarded, R38-blind path that reintroduces #785. The `$EDITOR` convenience is **not** the differentiator — `ntn pages edit` opens `$EDITOR` too; the safety wrapper is. |
| guarded body engine (`@overeng/notion-md`)       | (none — `ntn` is not a library)         | **KEEP**                 | A library dependency of `@overeng/notion-datasource-sync` (imports `observeRemoteBody` / `replaceRemoteBodyVerified`), not just CLI sugar. `ntn` is a binary with no embeddable API.                                                                                                                                           |
| `sync` / `status` / `plan`                       | (none — `ntn` is single-page only)      | **KEEP**                 | Multi-page, two-way subtree reconcile under a parent page (guarded 3-way Markdown merge, `.nmd` tree, conflict roughdrafts). `ntn` has no subtree/tree concept.                                                                                                                                                                |
| `notion schema`, `notion db sync/export`         | (none)                                  | **KEEP** _(notion-cli)_  | Schema codegen and guarded DB-row sync. No `ntn` equivalent. Owned by `@overeng/notion-cli`, listed for completeness.                                                                                                                                                                                                          |
| `cat`                                            | `ntn pages get`                         | **DEFER / RECONSIDER**   | Read-only; the only edge is base-hash emission (the optimistic-concurrency token the guarded `put` consumes) plus refuse-on-read for lossy pages. For a casual read, `ntn pages get` is _better_ (it surfaces a truncation warning we don't). Tracked as an open question.                                                     |
| raw datasource query / `api` / `files` / `login` | `ntn datasources`/`api`/`files`/`login` | **DEFER (no duplicate)** | Already `ntn`'s; we do not re-implement them. The steady-state boundary: our tooling is body/page editing + multi-page sync _on top of_ `ntn`, and reaches for raw `ntn` for everything else (queries, uploads, one-off API calls, auth).                                                                                      |

## Status

accepted

## Consequences

- The `cat` overlap is the one live tension: it is genuinely weaker than
  `ntn pages get` for casual reads and exists today only as the guarded-workflow
  read primitive (base-hash emission). Its future is captured as an open
  question (see [open-questions.md](../open-questions.md), spec `DQ1`): keep `cat`
  as the guarded-workflow read primitive vs. deprecate the casual-read command
  toward `ntn pages get`.
- Decision [0004](./0004-umbrella-surfacing.md) positions `notion edit` as the
  marquee "open my page in `$EDITOR`" verb. Since `ntn pages edit` now opens
  `$EDITOR` natively, that _positioning_ should lean on the guard/refuse-lossy
  property, not on the editor convenience — the verb still earns its place, but
  for the safety wrapper, not for being the only way to get `$EDITOR`.
- Using `ntn` to create E2E fixtures (see [experiments.md](../experiments.md)) is
  a **dependency** on the official CLI, not a duplication — it is the principle
  working as intended (reuse upstream rather than re-implement).
- A new command on a surface `ntn` already covers must add a clear-reason row to
  the audit table above (or be rejected). A clear reason that lapses (upstream
  closes the gap) flips the row to a deprecation candidate.
