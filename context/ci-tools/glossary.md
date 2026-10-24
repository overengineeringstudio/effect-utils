# CI Tools Glossary

**CI tools:** The Effect-based package and CLI that owns CI control-plane
runtime behavior such as workflow-report rendering and deploy preview
execution.

**Quarantine:** A declared, expiring allowance for a known-failing test target to
stay non-blocking. Reachable only through a ledger entry recording what is
suppressed, why, the tracking issue, and when the allowance lapses.

**Quarantine ledger:** The set of a repository's quarantine entries, keyed by
quarantine key. Owned by the consuming repository; `ci-tools` defines what an
entry means, never which targets are in it.

**Tolerated failure:** A test target failure that a quarantine allows to pass
without failing the job. Always announced, so it stays distinguishable from a
genuine pass.

**Deploy preview:** A deployed artifact or executable Worker version produced
from local repository inputs and published to a provider for review.

**Provider adapter:** The `ci-tools` module that translates the typed deploy
domain model into provider-specific API or CLI operations.

**Provider CLI fallback:** A deliberate provider adapter implementation choice
where `ci-tools` invokes the provider's CLI from an Effect-wrapped boundary
because direct API implementation would be less reliable or too costly.

**Hermetic E2E:** An end-to-end test that exercises the real `ci-tools` binary
and task boundary against fake providers without external provider network
dependencies.

**Live E2E:** An end-to-end test that uses real Netlify, Vercel, or Cloudflare
Workers credentials and projects, deploys a local artifact, verifies its marker
over HTTP at the final deploy URL, and records best-effort cleanup status.

**Shared provider project:** A real provider project also used for normal
preview surfaces. CI-tools E2E may use it only with explicit shared-project
permission and a reserved alias namespace.

**Reserved alias namespace:** A prefix, such as `ci-tools-e2e-`, that the tool
requires before live E2E may deploy to a shared provider project.

**Thin launcher:** A generated workflow step or Nix task that preserves a stable
entrypoint but delegates behavior to `ci-tools`.

**Cloudflare Workers deployment:** A Wrangler-backed publication of
consumer-built Worker output using the consumer's configuration and working
directory. Production deployment and PR version upload are distinct modes.

**Worker preview alias:** The stable review URL returned by Wrangler for a
version upload, distinct from that version's immutable preview URL. Ordinary PR
uploads use `pr-N`; shared-project live E2E requires an explicitly reserved,
unique alias before upload and does not move production traffic.

**Worker version cleanup:** Best-effort deletion of only the exact version UUID
returned by the live upload, scoped to the supplied account and Worker name.
The beta API accepts the Worker name as its Worker identifier. Cleanup status is
recorded even when marker verification fails and never replaces that failure.

**Trusted deploy job:** A credential-bearing job admitted only for a main
branch push or a same-repository pull request. Fork pull requests and
`pull_request_target` are excluded before any step executes.

**Executable-code trust boundary:** The boundary crossed when build scripts,
Worker code, or Wrangler configuration execute with deployment credentials.
An artifact-only upload policy for static sites does not establish trust for
executable Workers.
