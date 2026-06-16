# Deleting a visible placeholder is normal editing, not a flag-gated destructive mode

> **Superseded by [0016](./0016-refuse-lossy-pages.md).** With opaque blocks
> refused rather than placeholdered, there are no placeholders to delete, so the
> visible-vs-silent reinterpretation of R12 is moot in the streaming path.
> Retained for history.

R12 requires an explicit destructive mode to drop unknown blocks. That rule was
written for the pre-placeholder world where unknown blocks rendered as `''` and
were **invisible** in the body — a push could then drop them silently, with no
user intent. That silent loss is the real hazard.

Once unknown blocks render as **visible** placeholders (decision 0005), deleting
one is a deliberate, visible edit — indistinguishable in intent from deleting a
bullet. The invisible-vs-visible asymmetry that justified the flag is gone, so a
separate `--allow-delete-blocks` (briefly considered) is **retracted**: deleting
a visible placeholder is normal editing, no flag.

R12's protection is reinterpreted around _visibility_, not block class:

- **Visible** placeholdered block deleted → applied as a normal edit.
- **Silent** loss of an _invisible_ block (interim pre-placeholder state, or a
  block that cannot be represented as a placeholder at all) → still refused
  (exit 3, `NmdRemoteBodyLossyError`).

For transparency (R15 spirit, without friction), `put`/`edit` print a stderr
note listing referenced blocks removed by an edit.

## Status

superseded by 0016 (was: accepted — retracted the `--allow-delete-blocks` flag;
reinterpreted R12 around visibility)

## Consequences

- Notion deletions are recoverable via page trash, so an accidental placeholder
  deletion is recoverable — consistent with not flag-gating deletion of large
  ordinary blocks.
- (Historical, superseded by 0016/0017:) the placeholder + reconciliation model
  this bullet assumed was abandoned; opaque-block pages are now refused uniformly,
  so neither a placeholder nor an `--allow-delete-*` flag exists in the target.
