# Execution Platform Spec

This document specifies platform and executable-provider binding. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** configured platform identity, Nix-to-Buck input descriptors, and
stage-zero constraints.

**Does not define:** Nix product import or system realization.

## Input Flow

```text
Nix recipe + pin -> immutable store result -> provider descriptor -> Buck action
                                                |
target platform + execution platform -----------+
```

Provider descriptors are data read before action execution. They name exact
entrypoints and content identity; they do not permit actions to evaluate Nix.

## Provider Descriptor

```text
ExecutableProvider {
  schemaVersion
  toolId
  contentDigest
  entrypoint
  protocol
  executionPlatform
  runtimeRequirements
}
```

The configured action key includes the descriptor identity and selected target
and execution platforms. Repository adapters refer to logical `toolId` values;
consumer composition supplies the physical immutable provider.

## Platform Resolution

Platform selection is an explicit repository-policy input. Unsupported tuples
fail before executing an action. Host detection may choose among already
declared tuples for an interactive alias, but the configured tuple becomes part
of action and evidence identity and is never inferred during product import.

## Stage-Zero Rule

A stage-zero provider is admissible only when its producer lies outside the
graph it enables, its bytes and supported platforms are pinned, and a negative
test proves that an undeclared ambient copy is ignored. When no consumer needs
the provider, its bootstrap path is removed.
