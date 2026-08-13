# Buck2 execution platforms: requirements

## Scope

This slice defines the boundary between Nix-authored build-tool realizations and
Buck2 target/action graphs. It covers configured target and execution platforms,
stage-0 tools, tool identity, bootstrap, and portable execution inputs. It does
not select a remote-execution service or require that every action be remotely
executable.

## Authority

### BUCK.PLAT-R001: Nix recipe and pin authority

Nix MUST be the source of truth for:

- upstream source pins and hashes;
- compiler, linker, runtime, SDK, and helper-tool recipes;
- platform-specific patching and runtime closure construction;
- the reproducible stage-0 realization for every supported execution platform;
- the descriptor and content digest exported for Buck consumption.

Buck MUST own repository-local target edges, action inputs, action arguments,
and output declarations. Nix MUST NOT reconstruct a parallel repository build
graph, and Buck MUST NOT resolve mutable tools from ambient `PATH`.

### BUCK.PLAT-R002: one-way materialization boundary

The supported direction MUST be:

```text
Nix recipe + pins -> immutable platform artifact -> Buck tool/provider -> action
```

An action MUST NOT call Nix to discover or build a missing tool. Buck analysis
MUST fail when a required artifact or identity is absent.

## Platform model

### BUCK.PLAT-R003: configured target and execution platforms

Every platform-sensitive action MUST resolve both:

- a **target platform**, describing the artifact being produced; and
- an **execution platform**, describing the worker and tools executing the
  action.

Host inspection MAY be used by a developer-facing selector to choose a local
configured execution platform. Rule implementations and tool providers MUST NOT
use `host_info()` as proof that an action's configured executor or target is
compatible.

### BUCK.PLAT-R004: independent target/execution compatibility

Compatibility MUST be checked from declared constraints. Native execution MAY
require target and execution platforms to match. Cross-compilation MAY declare
different target and execution platforms only when the selected toolchain
explicitly supports that pair.

### BUCK.PLAT-R005: fail-closed platform support

Unknown operating systems, architectures, ABIs, delivery formats, and
target/execution pairs MUST fail during analysis or toolchain resolution. They
MUST NOT fall through to a default platform or fail later with `Exec format
error`.

The initial platform vocabulary MUST distinguish at least:

- `x86_64-linux`;
- `aarch64-linux`;
- `x86_64-darwin`;
- `aarch64-darwin`.

Declaring the vocabulary does not claim implementation support. Each tool and
action class MUST publish its supported subset.

## Tool identity and stage 0

### BUCK.PLAT-R006: exact tool identity

Every executable input MUST have an identity containing:

- logical tool name and contract version;
- execution platform and runtime ABI;
- artifact digest and size;
- entrypoint path;

Source revision, recipe identity, and producer provenance MUST remain available
as evidence, but MUST NOT enter a consuming action key when artifact bytes,
protocol, entrypoint, platform, and runtime behavior are unchanged.

The exact artifact, not merely a package name, version string, store prefix, or
ambient executable path, MUST participate in the consuming action key.
For an aggregate compiler provider, the identity material MUST enumerate every
configured executable and search path that any exposed language, linker,
archiver, binary-utility, documentation, lint, build-script, or action-helper
surface consumes. Omitting one field MUST fail closed rather than preserve the
aggregate identity.
That complete configuration-integrity identity MUST NOT be used as a universal
action or product identity. Each action class and product descriptor MUST bind
only the tools and semantic claims it consumes, so changing an unrelated lint,
documentation, Python, or binary-utility tool does not invalidate compilation
or packaging.

### BUCK.PLAT-R007: per-platform stage 0

Every execution platform claimed by an admitted action MUST have an
independently materialized and verified stage-0 tool set. Merely declaring a
platform vocabulary does not require speculative artifacts for unadmitted
platforms. A stage-0 executable MUST run on its execution platform without
consulting the repository's Buck-built copy of itself.

Stage-0 artifacts SHOULD be separate per helper when independent helper changes
must not invalidate unrelated actions. A multicall binary is permitted only
when measurements show that its shared invalidation and transfer cost are an
acceptable tradeoff.

### BUCK.PLAT-R008: no self-bootstrap cycle

A tool that verifies, unpacks, or selects a toolchain artifact MUST NOT depend
on the artifact it is validating. In particular, a Buck-built Rust verifier
cannot be the stage-0 verifier for the Rust toolchain needed to build that
verifier.

Nix-built stage 0 and a Buck-built twin MUST derive from the same canonical
source and dependency lock. The twin is parity evidence, not a second bootstrap
authority.

### BUCK.PLAT-R009: parity and deletion gate

A stage-0 replacement MUST preserve the predecessor's observable contract:
canonical outputs, file modes, payload layout, validation failures, and action
invalidation boundaries. The predecessor MUST remain until positive parity and
adversarial controls pass. After admission, the predecessor and its obsolete
configuration MUST be deleted rather than retained as a fallback.

## Tool delivery

### BUCK.PLAT-R010: current delivery contract

The initial admitted provider is an immutable local Nix realization and is
explicitly local-only. Any future portable or remote mechanism is a design
question, not required interface polymorphism. It becomes normative only when a
current consumer demonstrates the need, measured benefit, safe immutable
identity, and its own admission evidence.

## Cache granularity and observability

### BUCK.PLAT-R011: intentional invalidation

Tool inputs MUST be attached at the narrowest action boundary that consumes
them. Test-only, packaging-only, lint-only, or platform-inapplicable tools MUST
not invalidate compilation actions. Shared tool roots require measured
justification because changing their identity can invalidate every consumer.

### BUCK.PLAT-R012: evidence

Build evidence MUST make the following queryable per action:

- target and execution platform identities;
- selected toolchain and helper artifact identities;
- local, cache-hit, downloaded, or remotely executed outcome;
- materialized/downloaded bytes;
- action digest and invalidation explanation;
- bootstrap source (`stage0`) versus repository-built parity source (`twin`).

Admission MUST include cold, warm, metadata-only, relevant-source,
irrelevant-source, tool-identity, and wrong-platform controls.

### BUCK.PLAT-R013: admitted on-demand live-origin bootstrap

Every live-origin file or executable required by Buck analysis or an action,
including the CPython closure fetched on demand by Prelude Python rules, MUST
cross an immutable, digest-pinned Nix realization before consumption. Nix MAY
retrieve pinned source bytes through untrusted OCI transport, but the reviewed
source expectation, recipe, runtime closure, and realized tool descriptor
remain authoritative in this subsystem. Analysis and actions MUST NOT fetch
from a mutable upstream, registry tag, ambient interpreter, or developer
checkout. Its descriptor, bytes, execution platform, runtime closure, and
producer evidence MUST be independently verified, and changing that origin
MUST invalidate only declared consumers. The Buck-product importer in
`04-artifact-system-bridge` MUST NOT mediate this Nix-to-Buck stage-0 flow.

### BUCK.PLAT-R014: mutation-free shell activation

Development-shell activation MUST NOT invoke Buck, realize repository stage-0
tools, mutate repository projections, install dependencies, or synchronize
repository composition. Nix/devenv MAY expose immutable machine capabilities,
environment variables, and thin source-mode command adapters. Repository setup
and Buck target execution MUST remain explicit, demand-driven operations.

A warm Buck daemon accelerates the first repository command, not shell
activation. Warm-shell evidence MUST prove zero Buck invocations and zero
repository setup tasks. Warm-Buck evidence MUST separately prove zero executed
actions from Buck's own event/receipt authority.

### BUCK.PLAT-R015: durable and identity-bound lazy stage-0 cache

A cached lazy stage-0 projection MUST retain every referenced Nix output with a
GC root scoped to its semantic fingerprint. Reuse MUST validate the resolver
ABI, semantic fingerprint, complete expected tool-key set, executable contract,
and binding between each configured executable and its retained root. Missing,
stale, copied, or collected state MUST be a cache miss rather than a hit.
Concurrent resolution MUST single-flight per fingerprint, and semantic-input
instability during realization MUST fail after a bounded number of retries.

## Non-goals

- Reimplementing Nix package management inside Buck.
- Treating `/nix/store` syntax validation as platform compatibility proof.
- Making remote execution mandatory for integration tests with undeclared host
  or network requirements.
- Forking Prelude merely to satisfy a language-purity goal without measured
  system benefit.
