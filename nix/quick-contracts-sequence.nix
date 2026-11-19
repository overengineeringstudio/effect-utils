# Preserve the CI-owned hermetic posture surface without weakening host quick.
{
  ci ? builtins.getEnv "EFFECT_UTILS_CI_TEST" == "1",
}:
[
  "genie:editor-view-closure:check"
  "content-address:contract:check"
  "genie:check"
  "buck2:task-guards:check"
  "buck2:rust-deps:check"
  "buck2:cache-admission:check"
  "buck2:providers:check"
  "buck2:ts-sandbox:test"
  "lint:check:format:parity"
  "lint:check:standalone-staging"
  (if ci then "buck2:cache-posture:ci-test" else "buck2:cache-posture:test")
  "buck2:capabilities:test"
  "worktree:teardown:test"
  "cargo:proto-bindings:check"
  "check:buck2-producer-overlap"
  "lint:check:getflake"
  "nix:buck2-artifact-import:check"
  "nix:buck2-cargo-archives:check"
  "nix:buck2-launcher-independence:check"
  "nix:javascript-product-import:check"
  "otel:pipeline-run:test"
  "git-hooks:environment:test"
]
