# 2026-07-03 — Rename representation vs `weaver registry diff` (SC-R11 evidence)

Non-normative evidence for [.decisions/0009](../.decisions/0009-weaver-native-rename-representation.md).
Which registry representation of an attribute rename does OTel Weaver 0.24.2 classify as a
graceful rename, so the SC-R11 compat gate can consume weaver's own verdict instead of
reclassifying with custom logic?

## Hypothesis under test

A rename can be recorded two ways: keep the old key marked `deprecated: renamed_to`
(weaver-native), or drop the old key and record the old name in an out-of-band annotation on
the surviving new key (the `deprecatedAlias.was` shape from the downstream private consumer). The claim is that
only the first is natively understood by `weaver registry diff`.

## Method

Built three minimal synthetic registries against the real weaver 0.24.2 flake
(`nix/weaver-flake`): a baseline with a bare `service` attribute, and two candidates each
renaming `service` → `restate.service`:

- **A (retain + deprecate):** old `service` kept, marked
  `deprecated: { reason: renamed, renamed_to: restate.service }`; `restate.service` added.
- **B (drop old):** old `service` removed; only `restate.service` exists (the `was` pointer
  would live in a non-weaver annotation namespace).

Ran `weaver registry diff -r <candidate> --baseline-registry <baseline> --format json` and
`weaver registry check [--future]` on each.

## Results

- All three registries pass `check` and `check --future` (both shapes are schema-valid).
- **A → native rename.** Diff emits a dedicated change type, no removal:
  ```json
  [
    { "type": "added", "name": "restate.service" },
    {
      "type": "renamed",
      "old_name": "service",
      "new_name": "restate.service",
      "note": "Replaced by `restate.service`."
    }
  ]
  ```
- **B → breaking removal + unrelated add.** Diff has no knowledge of the intent:
  ```json
  [
    { "type": "added", "name": "restate.service" },
    { "type": "removed", "name": "service" }
  ]
  ```
- **`weaver registry diff` exits 0 in both cases** — it reports, it does not fail on breaking
  changes. A gate MUST inspect `changes.*[].type`, never the exit code.
- Weaver 0.24.2 accepts the object form `deprecated: { reason: renamed, renamed_to: <id> }`;
  `renamed_to` must reference an existing attribute id, and the rename surfaces only while the
  deprecated old attribute is retained in the head registry. This is the shape already used in
  the repo's generated `genie/weaver-registry/attributes.yaml`.

## Conclusion

- **Adopt representation A (weaver-native `deprecated: renamed_to`).** The SC-R11 gate consumes
  weaver's `type: "renamed"` directly — no custom rename-detection logic.
- **Reject representation B** (`deprecatedAlias.was`, drop old key): weaver reports a breaking
  removal the gate would have to reclassify against an annotation weaver ignores.
- Retaining the deprecated old key is also what carries the `bridge:` annotation
  ([0004](../.decisions/0004-metric-label-migration.md)), so the diff-gate story and the OTTL
  generation key off the same attribute.

→ SC-R11 gate wired to block on `type: "removed"` and pass `type: "renamed"`/`"added"`,
inspecting the JSON payload (exit code is always 0). Supersedes the downstream private
consumer's earlier `deprecatedAlias.was` API shape.
