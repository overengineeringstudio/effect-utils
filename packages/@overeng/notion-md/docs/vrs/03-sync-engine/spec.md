# Spec: 03-sync-engine

Specifies the shared correctness engine both surfaces call: the guarded push, the
conservative three-way Markdown merge from a base snapshot, the `update_content`
vs `replace_content` write-verb selection, the canonical base, the post-push
`semanticEquivalent` gate, the settle-and-re-pull, the review-safety guard, and the
explicit-force escape hatch. This is the authoritative home for those push-engine
mechanics; `edit`, the file path, and the `cat`/`put` 2-way facade all consume them
and cite here rather than restating them. Builds on
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

The write verb a merged body lands through (`update_content` vs `replace_content`)
is selected per the rules below.

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

## update_content vs replace_content

Both write verbs land through Notion's server-side Markdown parser, so the engine
never reconstructs blocks client-side ([04-fidelity](../04-fidelity/spec.md)):

- **`replace_content`** is the guarded default — the whole canonical body is sent
  and Notion re-parses it. Because the page was refused at the pull unless its body
  is fully representable (decision [0016](../.decisions/0016-refuse-lossy-pages.md), [04-fidelity](../04-fidelity/spec.md)), `replace_content` can never
  destroy an opaque block.
- **`update_content`** is an optimization. It may be used only when the base hunk
  is unique in the current remote body and the returned Markdown equals the
  expected body. Ambiguous or deletion-heavy edits fall back to guarded
  `replace_content`.

## Canonical Base

The engine's base snapshot (R09) is **the canonical body, and only ever the value
the first pull emitted.** Notion canonicalizes lists, ordered-list counters,
code-fence language, and blank lines at write time, so the engine adopts the
canonical body returned by the first pull as the base. A client must **never**
recompute the base locally over the editable buffer (which is pre-canonical until
the next pull); for `cat`/`put` the base hash is exactly the value `cat` printed to
stderr ([01-editor](../01-editor/spec.md#guard-plumbing), decision [0002](../.decisions/0002-base-hash-on-stderr.md)). The base
snapshots themselves are stored by [05-local-state](../05-local-state/spec.md).

Base tracking depends on hosted-media URL canonicalization for idempotence: media
URLs rotate on every pull, so the engine compares bodies only after the
canonicalization owned by [04-fidelity](../04-fidelity/spec.md#hosted-media-references) (R36, decision [0007](../.decisions/0007-canonicalize-hosted-media-urls.md)).

## Settle and Post-Push Verification

A remote write is not trusted until the engine settles it (R09, R11):

- **Post-push `semanticEquivalent` gate.** After a write, the engine re-reads the
  remote body and asserts it is semantically equivalent to the intended body
  (exit 9 on mismatch). The gate runs with hosted-media URL canonicalization so a
  rotated signed URL is not mistaken for a content change ([04-fidelity](../04-fidelity/spec.md#hosted-media-references), decision [0007](../.decisions/0007-canonicalize-hosted-media-urls.md)).
- **Settle and re-pull.** A successful write is settled by re-observing the remote
  body and refreshing the local base from that fresh, complete observation. If the
  refreshed observation is not complete, the local base stays untrusted and the
  caller receives a typed lossy-remote-body error rather than a stale clean base
  ([04-fidelity](../04-fidelity/spec.md), R38). Remote body is re-read immediately
  before a guarded Markdown write to catch races between status and write.

The surface-specific framing of these mechanics — `put`'s two-write body-first /
title-last order and its partial-write reporting (decision [0012](../.decisions/0012-non-atomic-title-body-write-order.md), exit 10) — is
specified where each surface drives the engine: [01-editor](../01-editor/spec.md)
for the `cat`/`put`/`edit` verbs and [02-file-sync](../02-file-sync/spec.md) for the
file path.
