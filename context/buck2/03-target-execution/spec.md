# Target Execution Spec

This document specifies the language-action boundary that turns generated
first-party target intent into declared Buck actions. It builds on
[requirements.md](./requirements.md). Toolchain construction, platform
realization, and stage0 publication belong to the sibling toolchain and
platform subsystem; this subsystem consumes their providers.

Status: **Draft**

## Scope

This specification defines language lowering, action decomposition, providers,
quality gates, stage0 consumption, and execution evidence. The semantic graph
and its common identities are owned by
[01-semantic-graph](../01-semantic-graph/spec.md). This subsystem does not
define a second target envelope, third-party dependency resolution, tool
recipes, execution images, remote schedulers, artifact publication, or system
activation.

## Requirement Trace

| Spec section             | Requirements                                |
| ------------------------ | ------------------------------------------- |
| Semantic target model    | BUCK.EXEC-R01, BUCK.EXEC-R02, BUCK.EXEC-R03 |
| Adapter and action graph | BUCK.EXEC-R04, BUCK.EXEC-R05, BUCK.EXEC-R06 |
| Provider boundaries      | BUCK.EXEC-R07, BUCK.EXEC-R11, BUCK.EXEC-R17 |
| Quality surfaces         | BUCK.EXEC-R08, BUCK.EXEC-R09, BUCK.EXEC-R10 |
| Stage0 consumption       | BUCK.EXEC-R12, BUCK.EXEC-R13                |
| Platform and evidence    | BUCK.EXEC-R14, BUCK.EXEC-R15, BUCK.EXEC-R16 |

## Semantic Target Consumption

```text
SemanticGraphV1 package and target
          |
          +-- stable identity and declared edges
          +-- operation contract
          `-- language payload
                    |
                    v
             language lowering
```

Target execution consumes `SemanticGraphV1` without renaming or renormalizing
its package IDs, target IDs, edges, platform requirements, visibility, or
declared input semantics. A language refinement may add a closed typed payload
whose schema is selected by the operation contract. It must not introduce a
parallel common envelope or include generator provenance in semantic identity.

Lowering validates only execution-specific invariants and emits rule calls and
provider edges. Generator ABI and helper implementation identity remain
projection or action inputs; they are not part of the stable semantic
fingerprint unless their observable contract changes.

## Adapter and Action Graph

```text
generated semantic target
          |
          v
  language adapter
          |
          +--> analysis-time validation
          +--> native language providers
          `--> separately keyed actions
                    |
                    v
             shared artifact boundary
```

A language adapter has two responsibilities:

1. Normalize and validate its language payload against the common envelope and
   package intent.
2. Render typed rule calls and provider relationships without resolving tools
   or third-party packages itself.

Adapters do not import each other. A closed dispatch over the supported
language tags selects the adapter. Shared helpers may implement path,
provenance, provider, and action-protocol mechanics, but may not erase
language-specific target states.

The action graph separates operations whenever their declared inputs differ.
In particular, a source compilation result does not implicitly certify lint,
format, test, documentation, binary normalization, or artifact packaging.
Private intermediate targets keep raw compiler or linker outputs out of the
public package interface while retaining their independent cache identities.

Every process action clears the ambient environment, constructs its required
environment explicitly, and invokes declared tool providers directly. A tool
may receive declared source trees, dependency projections, configuration, and
resources. It may not search the repository or user environment for omitted
inputs.

## Provider Boundaries

```text
LanguageCompileInfo ----+
LanguageRunInfo --------+--> quality and packaging consumers
LanguageQualityInfo ----+

BuckArtifactInfo ------------> artifact verifier and importer
BuckSupportToolInfo ----------> action implementations
```

The shared provider roles are:

| Provider role | Contract                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Compile       | Language-native compiled output plus the identity needed by downstream language actions.              |
| Run           | One declared executable and its explicit runtime resources.                                           |
| Quality       | Machine-readable diagnostics or inventory plus a separate passing validation output.                  |
| Artifact      | A reference to the build-product contract owned by the artifact/system bridge.                        |
| Support tool  | Executable, binary digest, target and execution platform, protocol ABI, and runtime closure identity. |

Language rules may expose native Prelude providers directly when those
providers carry the required contract. Thin pass-through providers are not
introduced solely to rename existing fields.

Artifact normalization and packaging consume language outputs through a common
binary or fileset boundary. They do not inspect TypeScript or Rust dependency
models. The final public target exposes `BuckArtifactInfo`; raw compilation and
normalization intermediates remain private unless a documented consumer needs
them.

## Quality Surfaces

```text
source graph
  |-- compile
  |-- lint ---------> diagnostics -> policy validation
  |-- format-check ----------------> validation
  |-- tests --------> inventory + executions + validation
  `-- doc-tests ----> inventory + executions + validation
```

Each adapter defines how its ecosystem maps onto these roles. A quality command
that exits successfully after writing diagnostics is only a producer. A
separate validation step applies repository policy and fails on prohibited
diagnostics.

Test evidence identifies every harness executable and every discovered case.
The validator compares that inventory with the generated semantic target model
or an independently established reference inventory. A zero-case harness is
valid only when the model explicitly declares that no cases apply.

Admission uses mutation controls at each quality seam: introduce a compile
failure, lint finding, formatting difference, test failure, and documentation
test failure; observe the expected RED action; restore the bytes; and observe
the corresponding GREEN action and stable result identity.

## Stage0 Consumption

Target execution consumes the executable provider defined by
[02-execution-platforms](../02-execution-platforms/spec.md). It does not inspect
delivery form, construct stage0, or define replacement policy. The action
protocol is versioned independently and declares all inputs, outputs, and
scalar policy; stdout remains diagnostic only.

## Platform and Execution Evidence

The target envelope names target-platform requirements and execution
constraints, while the sibling subsystem maps them to concrete Buck platforms
and tool realizations. Analysis rejects a target when no compatible provider is
available. Host inspection may protect an explicitly local bootstrap lane, but
does not constitute configured-platform support.

Execution exposes the normalized semantic target reference, configured target
and execution platforms, declared input and tool references, native Buck
identities, and output references to
[05-evidence-verification](../05-evidence-verification/spec.md). That subsystem
owns receipts, causal controls, and verdicts. Target execution must not define
a second evidence envelope.

## Language Refinements

- [TypeScript target execution](./01-typescript/spec.md)
- [Rust target execution](./02-rust/spec.md)
