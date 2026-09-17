# Buck2 Repository Build Open Questions

Subsystem questions live in their subsystem (`03-materialization`,
`05-composition`). These are cross-cutting.

## OQ1: Does the local check entry point stay a devenv verb over a Buck aggregate, or does Buck become the verb? — resolved by decision 0032

- Blocks: every consumer's local-check shape and the residual-gate list; the
  dissolution condition of `nix/devenv-modules/tasks/shared/check.nix` and the
  per-repo `check:*` fan-in.
- Two candidate shapes: (A) `devenv tasks run check:quick` runs one Buck
  aggregate target plus enumerated residual gates (dotfiles decisions 0020 and
  0027); (B) `buck2 test //...` is the gate and the devenv `check:*` tasks are
  deleted, with residual non-Buck gates rehosted.
- Resolution signal: a bakeoff experiment on the same admitted surface
  recording, for both shapes, warm no-op, fresh context with warm cache, and
  one-file-edit wall-clock (in-shell and pre-commit); build-machinery lines
  added versus deleted; a capability matrix (residual gates, task graph
  features, agent and skill ergonomics); and observability — which shape gives
  the check loop first-class OTel coverage (devenv trace versus Buck event log
  export). Johannes accepts deleting devenv tasks if Buck proves superior
  (q5, 2026-09-12).
- Resolution: resolved by decision 0032. Devenv keeps the stable outer verbs
  over one scoped Buck aggregate; the decision records the conditions for
  reconsidering the outer verb after the remaining capability gaps close.

## OQ2: How do public-repo CI runners share the cache with the private fleet? — resolved by decision 0033

- Blocks: BUCK-R06/R07 measurability in PR CI; consumer digest comparison
  (Phase 6); DQ1 in `03-materialization`.
- Constraint (q6, 2026-09-12): public repositories (effect-utils, livestore)
  run CI on Namespace runners to take load off dev3; private repositories stay
  on self-hosted tailnet runners. The shared generator currently pins
  `BUCK2_NO_REMOTE_CACHE=1` on every PR lane in every repo.
- Candidates to evaluate: ephemeral tailscale on a Namespace runner with a
  read-only action cache; a separate public cache endpoint with authenticated
  read and no PR write-back; a Namespace-native cache volume; distinct cache
  namespaces per trust tier with `main`-only write-back.
- Decision evidence: the
  [cache-posture experiment](./04-reuse/.experiments/2026-09-12-ci-cache-posture.md)
  eliminated the unsafe and non-REAPI options and established the required
  trust boundary. It produced no unchanged-head hit because the public tier
  does not yet exist; that measurement remains deployment proof, not evidence
  for choosing a different topology.
- Resolution: resolved by
  [decision 0033](./.decisions/0033-ci-cache-posture-two-trust-tiers.md).
  Public pull requests read but never write the isolated public tier; protected
  public `main` and both private lanes read and write within their trust tiers.
- Follow-up: refine BUCK-R06 and REUSE-R01 for the public read-only lane.
- Deployment blocker: the public-only cache tier is not deployed; until it is
  deployed and proven from a Namespace lane, public CI stays force-cold.

## OQ3: What must an external livestore contributor install?

- Blocks: livestore admission (q7, 2026-09-12: livestore is gated on this
  answer).
- The composition shape says an external consumer builds from the same
  synthesized single-member root and inhabits its own cache namespace; it does
  not say whether a contributor needs Buck, Nix, both, or neither for the
  common contribution loop.
- Resolution signal: a written contributor loop for livestore under each
  answer, with the tool set and cold-start time measured on a machine outside
  the fleet.
- Resolved (q17, 2026-09-14): livestore is an artifact consumer only. It pins
  `@overeng/*` release assets by tarball URL + integrity (decision 0034 once the
  artifact-composition proposal is accepted); no Buck2 or `mr` in livestore; its
  contributors install nothing new; livestore rows are excluded from the ledger.
  livestore PR #1622 closes.
