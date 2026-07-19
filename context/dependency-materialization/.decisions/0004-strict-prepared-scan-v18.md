# 0004 Strict Prepared Scan Uses One Version Bump

Status: accepted

## Context

Prepared dependency artifacts currently need a stricter data boundary: archived
`.bin` projection state, leaked package-manager state, unexpected native
outputs, and unclassified platform package directories should fail the prepared
artifact scan. Removing `.bin` changes recursive output hashes, so the
transition necessarily creates fixed-output hash churn.

## Evidence and Argument

- Prepared artifacts are dependency data; archived `.bin`, package-manager
  state, and unclassified native output violate that boundary.
- Removing `.bin` necessarily changes recursive fixed-output hashes, making the
  transition versioned regardless of rollout shape.
- Projection and native output already have separate owners, so a parallel
  lenient policy would preserve ambiguity rather than compatibility.

## Options

| Option | Tradeoffs |
| --- | --- |
| one strict v18 boundary | Converges immediately with mechanical hash churn. |
| report-only transition | Reduces initial disruption but permits known-impure artifacts indefinitely. |
| parallel strict/legacy profiles | Supports gradual adoption but doubles policy and hash authority. |

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

## Consequences

- The implementation milestone that lands strict scan enforcement must also
  refresh the impacted FOD hashes.
- CI and hash repair tooling should treat `v18` hashes as a new prepared
  artifact class, not as an incremental repair of `v17`.
- Any missing platform measurements remain represented by FOD hash evidence;
  they do not justify keeping an old prepared artifact scan policy alive.
