# 0012 Parallel Replay Phase Converging on a Proven Vertical Slice

Status: accepted

## Context

Execution stood frozen since 2026-08-14: three draft PRs (#1056 -> #1080 -> #1081), nothing merged, dotfiles-side dependencies parked. Foundation CI ran 23/24 green with one red `devenv-perf` job whose failure annotation (`task_pnpm_install` crash) matched the pnpm staged-source bug class fixed on main the next day (#1101/#1106/#1107). Products had never been proven end-to-end: zero experiments covered OTel evidence, real Nix import of a built product, real product targets, or Darwin.

## Evidence and Argument

Decision records Q1 (`0z3yqi`), Q2/Q3 (`j4ueu1`/`78nvqy`, duplicate record), Q4 (`l61ojp`), and Q5 (`haank2`) settled the phase goal, Darwin inclusion, evidence scope, and dispatch authorization on 2026-08-24. The full local foundation gate suite passed the same day (`devenv tasks run buck2:check`, exit 0) while clean-runner CI showed the same picture minus the stale perf job. tui-core already carries Buck target wiring, making it the thinnest real slice that crosses graph -> build -> product -> import -> evidence without a shortcut. Per-platform admission doctrine requires any unadmitted platform to be visibly unsupported; admitting Mach-O in-phase keeps the primary macOS ARM64 development fleet inside the claim instead of behind a marker. The epic's admission gates demand exact OTelite readback for claimed platform/operation tuples, so local readback belongs in the proof while managed Tempo/Mimir proof depends on parked dotfiles work and stays behind managed-adoption prep.

## Options

| Option                                                                                       | Tradeoff                                                                                    | Outcome       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| Merge foundation immediately, replay after                                                   | Fastest first merge, but products stay unproven against the contracts they must validate    | Rejected (Q1) |
| Parallel replay converging on a vertical slice; Darwin lane in phase; OTelite-local evidence | Slower first merge, but every merge-blocking claim is proven end-to-end; lanes isolate risk | Accepted      |
| Defer Mach-O behind visible-unsupported marker                                               | Smaller surface now, but primary fleet stays outside the admitted set                       | Rejected (Q2) |
| Full D milestone including managed Tempo/Mimir proof                                         | Strongest claim, but pulls parked dotfiles dependencies into the critical path              | Rejected (Q4) |

## Decision

Run adoption as a parallel replay phase that lands a principled vertical slice before any PR flips ready:

1. Lane 0 rebases #1056 onto main and rechecks devenv-perf.
2. Lane A proves ELF products end-to-end (TypeScript + Rust, x86_64 plus musl static).
3. Lane B implements the Mach-O runtime-inspection adapter and Nix import dispatch, parallel to lane A.
4. Lane C wires native Buck evidence through exact OTelite local round-trip; NO_VERDICT on mismatch.
5. The vertical slice is tui-core e2e: Buck build -> strict v1 product -> independent Nix import -> OTelite local readback, using real invalidation semantics and fail-closed import with no shortcuts.
6. Per-milestone adversarial review/verify/critique passes gate convergence; prototype/experiment/research sub-agents de-risk ahead; tradeoffs, open questions, and scope stay surfaced continuously.
7. The buck2 pin stays at nixpkgs `2026-04-15` through replay; bump toward upstream `2026-08-22` is scheduled post-merge.
8. Verification is CI-first while dotfiles#1335 keeps dev3 oversubscribed; mbp2021 hosts the Darwin lane.

## Consequences

- Milestone C/D progress is measured by the vertical slice rather than layer completion.
- Mach-O inspection contract mistakes version the artifact variant instead of blocking the ELF lane.
- devenv-perf policy tension (blocking classification vs advisory epic text) stays open until the rebased run yields real signal.

## Amendment 1

The redesigned roadmap and decision 0016 supersede items 1–6 and 8 as an
execution/evidence plan; they remain historical context for why replay was
chosen. Item 7 remained a live sequencing constraint and is now discharged:
after the Phase-1 tui-core authority-transfer gate passed, the repository
advanced directly to immutable upstream Buck2 `2026-08-22`
(`c89474de8970db1d3784063e2fb1efb1803bb177`) through a narrow package
override. Compatibility evidence is retained in
[2026-08-27-buck2-pin-2026-08-22.md](../02-execution/.experiments/2026-08-27-buck2-pin-2026-08-22.md).
