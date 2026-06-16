# `edit` is an ephemeral file-engine session; `cat`/`put` are the only stateless pipes

`notion edit` is **not** a second push engine. It is sugar over the existing
file-based `sync` engine: pull the page into an ephemeral `.nmd` + `.notion-md/`
under `$TMPDIR`, present the body (default mode: `# title` + body) in `$EDITOR`,
splice the edit back into the envelope, push through the existing guarded
`syncPage`, then delete the temp dir. Only `cat` and `put` stay gateway-only
(stateless stdin/stdout body pipes).

This collapses `edit` from a bespoke streaming push path into a thin wrapper over
`pullPage` + body splice + `syncPage` + temp-dir cleanup, and lets it inherit the
mature engine's guarded push, 3-way Markdown merge, settle-and-re-pull, and
out-of-band preservation — none of which needs reimplementing.

## Why

The file engine is fully location-relative (state paths derive from the `.nmd`
path argument; no `process.cwd()`), and the live test suite already drives it
inside a `mkdtemp` dir, so an ephemeral `$TMPDIR` session is a supported
configuration, not new surface. The engine detects both remote-body conflict and
schema drift from the **base snapshot** it captures at pull — exactly what a
pull-at-start / push-at-end session has — so `edit` needs no separate guard
machinery.

## Consequences

- **Refuse-lossy is uniform across `cat`/`put`/`edit` (and `sync`).** The engine
  refuses a lossy body at the **pull** gate (`assertRemoteMarkdownComplete`), and
  `edit` materializes through that same `pullPage`. So `edit` refuses the same
  opaque-block pages `cat`/`put` refuse — it does **not** preserve/edit them (the
  earlier "edit handles lossy pages" framing was a latent-bug artifact, see R38).
  Decision 0016's refusal is therefore a property of the **shared core**, not a
  streaming-only carve-out. `edit` gains reach over `cat`/`put` only on
  _representable_ pages (object store, 3-way merge, `unsupported_blocks`
  preservation of resolvable blocks).
- **R38 is a blocking prerequisite and a real file-path bug fix.** Today the
  classifier flags only API-`unsupported` blocks, so `child_database` /
  `table_of_contents` / `synced_block` mis-classify `complete` and a
  `replace_content` push silently destroys them — in the existing file path, not
  just streaming. The uniform refusal above is only sound once R38 lands.
- **The stateless in-buffer schema-drift fingerprint is superseded and deleted**
  (removes R42; impl-delta Group F is repurposed from the fingerprint to a
  small engine `schema_snapshot` addition). It existed solely because a stateless
  pipe has no base snapshot. `edit --frontmatter` runs over the engine's base
  snapshot, so drift is detected by snapshot comparison (a `schema_snapshot`
  sidecar role the file engine must capture at pull and compare at push — a small
  engine addition, strictly simpler than a parallel in-buffer fingerprint
  re-derived by an independent implementation).
- **`cat`/`put` are body-only pipes; structured property editing moves to `edit`.**
  `cat --frontmatter` (read) survives — a stateless envelope dump is safe and
  useful in pipes. **Stateless `put --frontmatter` (property _write_) is dropped**:
  a safe property write needs drift detection, which needs a base snapshot, which
  means `edit --frontmatter` (interactive) or the file-based `sync` (scripted).
  This is the one capability cut — non-interactive property writes use `sync`.
- **The bespoke two-write partial model (0012) applies only to the stateless
  pipe.** `edit` inherits the engine's settle-and-re-pull, so the exit-10
  partial-write model is not part of `edit`; `put` (body + title, two writes)
  keeps exit 10. **Schema drift is surfaced as exit 6**, redefined from the
  deleted stateless fingerprint to the engine's `schema_snapshot` comparison for
  `edit --frontmatter` / `sync` (R14) — distinct from the exit-7 conflict so it is
  not `--force`-able.
- **`edit` forces a full-body `replace_content`.** Post-R38 every page `edit`
  accepts is representable (opaque pages refused at the pull), so a full replace is
  safe and closes the engine's targeted-`update_content` silent-partial-apply
  window for the single-session case.
- **Temp-dir lifecycle and conflict relocation are the new edges.** `edit` must
  scope-clean the `$TMPDIR` dir on success / conflict / editor-abort / interrupt,
  and copy any `.conflict.roughdraft.md` out of `$TMPDIR` (which is reaped) to a
  durable sibling so a conflicted edit is recoverable.
- **Statelessness is preserved where it is intrinsic (the pipe), incidental
  elsewhere.** `cat`/`put` write nothing; `edit` writes a `$TMPDIR` temp tree
  (never the cwd) — consistent with decision 0003 / T07, which already conceded
  `edit` is a temp-file session, not an in-memory buffer.

## Status

accepted (supersedes the stateless in-buffer schema fingerprint; redefines 0003,
0008, 0012; broadens 0016 to uniform)
