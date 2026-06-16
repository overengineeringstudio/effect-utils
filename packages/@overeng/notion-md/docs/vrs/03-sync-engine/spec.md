# Spec: 03-sync-engine

Specifies the shared correctness engine both surfaces call: the guarded push, the
conservative three-way Markdown merge from a base snapshot, the settle-and-re-pull,
the review-safety guard, and the explicit-force escape hatch. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the architecture
index.

Traces: R09, R11, R13, R15. The pull/status/push flows that drive this engine are
specified in [02-file-sync](../02-file-sync/spec.md); the editor's `edit` verb
reuses this engine ([01-editor](../01-editor/spec.md), decision 0017); the stateless
`cat`/`put` pipes use the gateway-only 2-way verified-replace facade. The base
snapshots compared here are stored by [05-local-state](../05-local-state/spec.md);
the lossy-page refusal that prevents a `replace_content` over an opaque block is
owned by [04-fidelity](../04-fidelity/spec.md) (R30/R38).

## Guarded push model

Both surfaces push the body through a **guarded Markdown surface** — there is no
block-reconciliation engine ([04-fidelity](../04-fidelity/spec.md), R40/R41):

- **Stateless `cat`/`put`** — a 2-way guarded verified replace: re-read remote,
  compare against the caller's `--base-hash`, refuse on drift (exit 7) unless
  `--force`, then `replaceRemoteBodyVerified` → `replace_content` ([01-editor](../01-editor/spec.md)).
- **File path and `edit`** — a 3-way Markdown merge from the engine's base
  snapshot, then a guarded `replace_content`. `edit` reuses this wholesale
  (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)): pull-at-start captures the base snapshot, push-at-end compares it
  and auto-merges non-overlapping concurrent edits.

The base snapshot (R09) is the engine's optimistic-concurrency token; a stale base
is refused (R11), and a destructive override (R15) is separate from normal push and
reports exactly which protection it bypassed (`--force` is concurrency-only,
decision [0009](../.decisions/0009-force-is-concurrency-only.md)).

## Merge And Conflict Policy

Requirement trace: R11–R15.

Body merge operates on canonical Markdown:

| Case                          | Result                                    |
| ----------------------------- | ----------------------------------------- |
| local equals remote           | clean                                     |
| local equals base             | accept remote                             |
| remote equals base            | accept local                              |
| non-overlapping ranges        | merge                                     |
| same-range same edit          | accept merged edit                        |
| overlapping different edit    | conflict                                  |
| protected placeholder removal | conflict unless explicit destructive mode |

`update_content` is an optimization. It may be used only when the base hunk is unique in the current remote body and the returned Markdown equals the expected body. Ambiguous or deletion-heavy edits fall back to guarded `replace_content`.

Unresolved conflicts are written beside the `.nmd` file as Roughdraft Markdown:

```markdown
# notion-md body conflict

{==Body conflict==}{>>Remote and local body content both changed since the last clean pull.<<}{id="body-conflict"}

## Base body

...

## Local body

...

## Remote body

...
```

Normal push refuses unresolved Roughdraft review markup (R13). Explicit modes may
later apply, render, strip, or bridge review annotations. (`edit` relocates a
conflict artifact out of `$TMPDIR` to a durable `<page>.conflict.md`; see
[01-editor](../01-editor/spec.md#edit-session).)
