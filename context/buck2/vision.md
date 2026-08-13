# Buck2 Repository Build Vision

## The Problem

1. **Coarse repository work:** Repository-local compilation, checking, testing,
   and packaging are routed through tools whose evaluation and cache boundaries
   are broader than the semantic change being made.
2. **Overlapping authorities:** Nix, package-manager tasks, ecosystem build
   tools, and repository wrappers can independently perform equivalent work,
   increasing drift, maintenance, and invalidation cost.
3. **Opaque reuse:** Developers and CI cannot consistently explain why work
   ran, which inputs caused it, whether results were reused, or whether an
   artifact is safe to consume on another host.
4. **Unsafe system handoff:** Bypassing Nix for speed can lose reproducible tool
   recipes, runtime composition, managed-system activation, and rollback.
5. **Repository-local solutions do not compound:** Build improvements that
   encode one repository's paths, private topology, or task wrappers cannot be
   reused safely across megarepos and system configuration.

## The Vision

- Every repository-local result is a fine-grained, explainable, and reusable
  computation whose identity follows its true semantic closure.
- One build graph owns repository-local compilation, validation, testing,
  code generation required by those actions, and packaging.
- Nix remains the declarative system boundary for tool recipes, artifact
  verification, runtime composition, activation, and rollback.
- Generated build topology is a stable projection of package intent rather
  than another hand-maintained source of truth.
- Native evidence makes executed, reused, materialized, imported, activated,
  and observed-live states distinguishable.
- The contracts are portable across public and private repositories without
  leaking private facts or merging trust domains.

## What This Is Not

- It is not a replacement for Nix, Home Manager, NixOS, or nix-darwin as system
  configuration and lifecycle authorities.
- It is not permission to keep permanent parallel build authorities as
  fallbacks.
- It is not a single workspace-wide target, global mutable cache, or universal
  lowest-common-denominator language rule.
- It is not a requirement that every tool be relocatable; immutable execution
  images and platform packages are valid when their identity is explicit.
- It is not a rollout plan. Pull-request order and current migration state are
  derived from this contract and tracked separately.

## Success Criteria

1. An irrelevant content or metadata change executes no actions for an
   unaffected target, while a relevant mutation executes the exact affected
   closure.
2. Each admitted repository-local operation has one terminal build authority;
   the superseded producer is absent from normal development, CI, release, and
   activation paths.
3. A clean compatible host can reproduce or reuse an admitted result using only
   declared sources, dependencies, tools, platforms, and policies.
4. Nix imports and activates verified Buck-produced artifacts without
   rebuilding repository sources, and the previous managed generation remains
   independently recoverable.
5. Every authority claim is backed by complete native evidence and a causal
   RED-before/GREEN-after control at the claimed seam.
6. The same versioned semantic graph, execution, artifact, and evidence
   contracts pass conformance in at least two independently owned repositories.
7. Adding an admitted target primarily adds semantic data; repeated lifecycle
   and verification behavior remains shared, and temporary migration surfaces
   have explicit deletion conditions.
