# CI Tools Glossary

**CI tools:** The Effect-based package and CLI that owns CI control-plane
runtime behavior such as workflow-report rendering and deploy preview
execution.

**Deploy preview:** A deployed static artifact produced by local repository
tasks and uploaded to a provider for review.

**Provider adapter:** The `ci-tools` module that translates the typed deploy
domain model into provider-specific API or CLI operations.

**Provider CLI fallback:** A deliberate provider adapter implementation choice
where `ci-tools` invokes the provider's CLI through Effect `Command` because
direct API implementation would be less reliable or too costly.

**Hermetic E2E:** An end-to-end test that exercises the real `ci-tools` binary
and task boundary against fake providers without external provider network
dependencies.

**Live E2E:** An end-to-end test that uses real Netlify or Vercel credentials
and projects, deploys a local static fixture, verifies the served result, and
records cleanup status.

**Shared provider project:** A real provider project also used for normal
preview surfaces. CI-tools E2E may use it only with explicit shared-project
permission and a reserved alias namespace.

**Reserved alias namespace:** A prefix, such as `ci-tools-e2e-`, that the tool
requires before live E2E may deploy to a shared provider project.

**Thin launcher:** A generated workflow step or Nix task that preserves a stable
entrypoint but delegates behavior to `ci-tools`.
