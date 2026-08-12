# TypeScript Target Execution Spec

This document specifies TypeScript target execution. It refines the shared
[target execution spec](../spec.md) and satisfies
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This specification defines TypeScript semantic targets, isolated source and
dependency staging, quality actions, executable compilation, and the artifact
handoff. Package-manager resolution and dependency materialization are upstream
inputs; tool and platform realization belong to the sibling toolchain and
platform subsystem.

## Requirement Trace

| Spec section        | Requirements                                                           |
| ------------------- | ---------------------------------------------------------------------- |
| Semantic targets    | BUCK.EXEC.TS-R01, BUCK.EXEC.TS-R02, BUCK.EXEC.TS-R03, BUCK.EXEC.TS-R12 |
| Declared workspace  | BUCK.EXEC.TS-R04, BUCK.EXEC.TS-R05, BUCK.EXEC.TS-R07                   |
| Tool providers      | BUCK.EXEC.TS-R06                                                       |
| Quality graph       | BUCK.EXEC.TS-R08, BUCK.EXEC.TS-R09, BUCK.EXEC.TS-R10                   |
| Executable artifact | BUCK.EXEC.TS-R03, BUCK.EXEC.TS-R11                                     |

## Semantic Targets

```text
TypeScriptPackageIntent
  |-- project-check targets
  |-- lint and format targets
  |-- test targets
  `-- executable targets
```

The adapter consumes a tagged model:

```typescript
type TypeScriptTarget =
  | TypeScriptProjectCheck
  | TypeScriptLint
  | TypeScriptFormatCheck
  | TypeScriptTest
  | TypeScriptExecutable

interface TypeScriptProject {
  readonly tsconfig: RepoRelativePath
  readonly sources: readonly RepoRelativePath[]
  readonly projectReferences: readonly TargetLabel[]
}

interface TypeScriptOperation {
  readonly project: TypeScriptProject
  readonly dependencyRoots: readonly DependencyRootRef[]
  readonly dependencyClosure: ClosureLabel
}

interface TypeScriptExecutable extends TypeScriptOperation {
  readonly kind: 'executable'
  readonly entry: RepoRelativePath
  readonly outputName: string
  readonly buildIdentity: BuildIdentityInput
  readonly runtimeAbi: RuntimeAbi
}
```

Lint, format, and test variants add their tool configuration, declared scope,
and expected inventory contract. The adapter validates that every source is
owned once per role, project references point to declared providers, and an
entrypoint belongs to the executable's source graph.

The external dependency closure is an opaque, versioned upstream projection.
The adapter names the closure and required package capabilities; it does not
parse the lockfile, choose package versions, or infer dependencies from source
imports.

Package composition exposes rootable declarations as field-qualified handles:

```typescript
ts.test({
  uses: [deps.dependencies.effect, deps.devDependencies.vitest],
})
```

The operation authors only these use edges. Composition remains authoritative
for aliases, requests, and workspace provenance. The TypeScript brand provides
compile-time authoring safety; runtime validation resolves each structural
reference against a canonical declaration for its owning package and rejects
unknown, foreign-package, and non-rootable fields. Normalization emits sorted,
duplicate-free `{ package, field, alias }` values and erases package-specific
generic types. Peer dependencies are not execution roots until a peer-context
contract is specified.

## Declared Workspace

```text
declared sources + configs + workspace providers + package closure
                              |
                              v
                     isolated workspace
                              |
                +-------------+-------------+
                v                           v
          compiler/tool                 test/runtime
```

The staging action creates a fresh root and maps each declared input to a
validated repository-relative location. It rejects absolute paths, parent
components, duplicate destinations, file/directory ancestor collisions,
escaping links, and missing required configuration.

Workspace packages enter through declared providers. External package content
enters through the exact role- and platform-qualified closure. Native packages
are selected by configured platform attributes before staging. No source-tree
or user-level `node_modules` path is visible to the action.

The staged filesystem normalizes result-affecting metadata and does not encode
checkout paths. Compiler and runtime processes receive an empty or hostile
ambient `PATH`, a private home directory, and only documented environment
variables.

## Tool Providers

| Role             | Required provider capability                                          |
| ---------------- | --------------------------------------------------------------------- |
| Project checking | TypeScript compiler executable and compiler ABI                       |
| Lint             | Linter executable, rules/configuration identity, and report protocol  |
| Format           | Formatter executable, configuration identity, and check-only protocol |
| Test             | Test runner/runtime executable and inventory/report protocol          |
| Executable       | Runtime/bundler executable and compilation protocol                   |
| Normalization    | Platform-specific executable normalizer and runtime ABI contract      |

The adapter receives these capabilities through the shared support-tool and
toolchain providers. Tool versions or store paths never appear as independently
maintained package target metadata.

## Quality Graph

```text
project sources
  |-- project-check -> typed validation marker
  |-- lint ----------> report -> policy validator
  |-- format-check ----------------> policy validator
  `-- tests ---------> inventory + result -> policy validator
```

Project checking consumes the declared project-reference graph and emits a
validation marker bound to the project configuration and compiler identity.
That marker is a sibling validation result joined only by an aggregate quality
target. Production compilation does not consume it unless the operation
contract proves that the checked state changes executable bytes.

Lint and test tools emit structured reports when supported. Their validators
apply repository policy and return a distinct success artifact. Format checking
compares formatter output without rewriting declared sources. Test validation
joins the discovered case inventory with the generated semantic target and
rejects missing, duplicate, or unexpectedly empty cases.

Every quality action has a negative control that mutates only its relevant
semantic input. Restoration must recover the baseline result identity. Changes
to tests or lint-only configuration do not invalidate a production executable
unless those bytes are declared compilation inputs.

## Executable and Artifact Flow

```text
production sources + runtime closure ----> executable compilation
project-check marker --------------------> aggregate quality gate
                                                |
                                                v
                                      admitted executable
                           |
                           v
                    native normalization
                           |
                           v
                    artifact packaging
```

Compilation injects the shared build-identity contract at the executable leaf
and emits one raw executable provider. Normalization applies the configured
runtime ABI without changing language semantics. Packaging emits the shared
artifact provider and structured provenance.

The deployment consumer verifies and imports that artifact. It may add system
wrappers or runtime dependencies, but it does not invoke the TypeScript
compiler, runtime bundler, or package manager against repository sources.
