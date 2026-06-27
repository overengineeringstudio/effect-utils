# Nix Prepared Dependencies Experiments

This file records non-normative prepared-deps evidence.

## Directory-Shaped FOD Output

Hypothesis:

- A deterministic tar file can be the fixed-output payload for prepared
  dependencies.

Result:

- Rejected. Archive serializer bytes became part of the hash boundary and
  caused cross-platform drift unrelated to dependency semantics.

Conclusion:

- Keep the fixed-output artifact directory-shaped. Tar streams may be used as
  copy/restore transport only.

## Tar Stream Copy And Restore

Hypothesis:

- Tar streams can speed internal copy/restore while preserving a recursive
  directory FOD boundary.

Result:

- Accepted. The explored implementation preserved output sizes and recursive
  hash semantics while reducing dependency preparation time in measured cases.

Conclusion:

- Copy/restore mechanics may be optimized when they do not change the
  fixed-output contract.

## Root Patch Inheritance

Hypothesis:

- Nested install roots can inherit patch authority from the root lockfile and
  workspace file without running an unfrozen pnpm repair step.

Result:

- Accepted with edge-case coverage for scalar `patchedDependencies`, exact
  package selector matching, and peer-suffix preservation.

Conclusion:

- Patch inheritance belongs in deterministic staging logic, not in build-time
  lockfile mutation.
