# pnpm Repo-Boundary GVS Open Questions

This file is intentionally temporary. The goal is to dissolve it by either:

- resolving the question in implementation and moving the answer into
  [spec.md](./spec.md), or
- rejecting the direction and removing the now-obsolete question

## Q1. Which composition-local link encoding should we use?

Current candidates:

- aggregate-root `pnpm.overrides` to local `link:` targets
- generated composed-only aggregate manifests with `link:`

Decision criteria:

- keeps standalone manifests publishable
- works with GVS
- stays explicit and deterministic
- is easy to generate with Genie

Current status:

- `pnpm.overrides` keeps package manifests clean
- manifest `link:` was better validated in the earlier repros
- we still need the final comparison on ergonomics and GVS behavior

## Q2. Can strict peer alignment make peer-sensitive packages safe?

Hypothesis:

- Genie-managed peer alignment for our own packages, plus explicit overrides
  for selected external packages, may be enough to avoid duplicate live
  instances across the repo boundary

Why it is still open:

- the current aligned-peer repro still split runtime identity
- that means version alignment alone is not sufficient in the current shape

What would resolve it:

- a repro where peer-sensitive packages converge to one live instance under
  the final composition encoding
- or a principled constraint on which packages may cross the repo boundary

## Q3. How strict should the managed `pnpm` wrapper be?

Questions:

- should unsupported nested installs fail or redirect?
- should raw `pnpm install` always delegate to `dt`?
- what exact signal marks a nested repo as already installed and ready?

Why it matters:

- `preinstall` hooks are too late to protect the worktree
- the shell wrapper is the real enforcement point

## Q4. What is the right CI posture for GVS?

Questions:

- should composed+GVS CI be required immediately or start as advisory?
- do we keep standalone CI on normal pnpm while the composed lane exercises
  GVS explicitly?
- do we need a dedicated duplicate-instance smoke test in CI?

Why it matters:

- pnpm treats GVS as experimental
- if local dev depends on it, CI needs explicit coverage

## Q5. How do we surface local-link intent mismatches?

Examples:

- a package was expected to resolve locally but resolved from the registry
- a composed topology forgot to encode a required cross-repo local link

Possible directions:

- explicit validation command in `dt`
- lockfile inspection
- runtime smoke check that reports the resolved physical path

## Q6. Do we need special handling for peer-sensitive external packages?

Possible directions:

- explicit root-level overrides
- forcing one canonical version set in the composed topology
- disallowing selected packages from crossing repo boundaries as linked
  source packages

This question stays open until the peer-sensitive repros have a convincing
resolution.
