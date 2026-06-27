# 0004 Strict Prepared Scan Uses One Version Bump

Status: **Accepted**

## Context

Prepared dependency artifacts currently need a stricter data boundary: archived
`.bin` projection state, leaked package-manager state, unexpected native
outputs, and unclassified platform package directories should fail the prepared
artifact scan. Removing `.bin` changes recursive output hashes, so the
transition necessarily creates fixed-output hash churn.

## Decision

Use one convergent prepared artifact version bump for the strict scan
transition.

The next strict prepared-deps purity transition:

1. bumps the prepared artifact layout version to `v18`;
2. strips and rejects archived `.bin` projection state;
3. fails on leaked pnpm store/home/state paths;
4. fails on unexpected native output and unclassified platform package dirs;
5. refreshes every affected fixed-output hash as part of the same transition.

Do not introduce a report-only phase, and do not keep old and new scan policies
active behind profile gates once `v18` lands.

## Rationale

- Prepared dependency artifacts are data artifacts. Carrying a lenient legacy
  scan beside the strict scan would keep the most important ambiguity alive.
- The hash churn is real but mechanical. It is better handled as an explicit
  versioned boundary than as piecemeal report-only drift.
- Projection and native output ownership are already modeled separately, so the
  strict scan is the clearest convergence point for the Nix-prepared realization.

## Consequences

- The implementation milestone that lands strict scan enforcement must also
  refresh the impacted FOD hashes.
- CI and hash repair tooling should treat `v18` hashes as a new prepared
  artifact class, not as an incremental repair of `v17`.
- Any missing platform measurements remain represented by FOD hash evidence;
  they do not justify keeping an old prepared artifact scan policy alive.
