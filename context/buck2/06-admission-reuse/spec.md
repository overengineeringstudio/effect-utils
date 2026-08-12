# Admission and Reuse Spec

This document specifies the deterministic predicate that grants a bounded Buck
capability and the proof required before contracts are called reusable. It
builds on [requirements.md](./requirements.md).

Status: **Draft**

## Scope

This subsystem owns gate policy, deterministic evaluation, authority-switch
invariants, and second-consumer conformance. It references semantic subjects
and evidence owned elsewhere. It does not own another graph, artifact envelope,
evidence record, mutable rollout ledger, replication package, or runtime
fallback.

## Requirement Trace

| Section               | Requirements     |
| --------------------- | ---------------- |
| Admission predicate   | BUCK.ADM-R01-R04 |
| Authority switch      | BUCK.ADM-R05-R08 |
| Capability trust      | BUCK.ADM-R09-R10 |
| Reuse and contraction | BUCK.ADM-R11-R14 |
| Reuse planes          | BUCK.ADM-R15-R18 |

## Admission Predicate

```text
subject reference + policy + evidence-envelope references
                         |
                         v
              deterministic predicate
                 /        |        \
         admitted      rejected    no-verdict
```

The subject reference binds the exact semantic slice and platform/tool/artifact
tuple. The policy selects required gates and acceptable proof kinds. Each gate
is `pass`, `fail`, or `unavailable` with references to evidence owned by
`05-evidence-verification`.

The aggregate is `admitted` only when all gates pass, `rejected` when any gate
fails, and `no-verdict` when no gate fails but required evidence is absent,
incomparable, or incomplete. The evaluator emits the verdict as a pure derived
value; content-addressing or persistence uses the evidence subsystem's schema.

## Gate Classes

| Gate                   | Required claim                                                            |
| ---------------------- | ------------------------------------------------------------------------- |
| Functional equivalence | Result and failure semantics match the operation contract                 |
| Invalidation precision | Relevant changes affect the exact closure and irrelevant changes do not   |
| Reproducibility        | Equal declared inputs reproduce promised identities                       |
| Platform               | Every claimed target/execution tuple has the required proof kind          |
| Observability          | Invocation, action, cache, artifact, and system states remain joinable    |
| Performance            | Comparable samples satisfy declared latency and resource budgets          |
| System bridge          | Nix verifies/imports without rebuilding repository source when applicable |
| Complexity             | No overlapping route or permanent duplicate abstraction remains           |

Repeated observations are expressed by sample count and independence criteria,
never by wall-clock soak duration.

## Authority Switch

Candidate implementation and proof may exist while the legacy path remains
authoritative. Once gates pass, one coherent authority change:

1. routes developer commands, CI, and system consumers to the Buck result;
2. deletes the superseded producer, alias, and implicit fallback for that exact
   domain;
3. proves remaining legacy domains are disjoint; and
4. records a rollback pointer to the prior coherent authority state.

There is no admitted intermediate state with two authoritative producers.
Current target inventory, progress, and deletion tasks live in roadmap records
and GitHub issues rather than a second normative graph.

## Capability Trust

```text
local execution
  +-- remote-cache read
  +-- remote-cache write
  +-- remote execution
  +-- verified Nix import
  +-- system activation
  `-- artifact collection
```

The branches are separately admitted; indentation does not imply authority.
Writable namespaces and credentials are qualified by repository trust domain.
Public, private, and sensitive artifacts have explicit classifications.
Negative controls cover forged provenance, cross-namespace writes,
path-dependent replay, poisoned entries, secret leakage, and wrong-platform
execution.

### Independent reuse planes

```text
Buck REAPI cache     OCI product transport     Nix binary cache/store
 action results       final products + bundle   imported realizations
      |                       |                         |
      +--------- separate identities and verdicts -----+
```

These planes may share observability joins, but not authority. Buck REAPI is an
execution optimization, OCI is untrusted product distribution, and the Nix
store/binary cache serves verified Nix realizations. Each has distinct writer
credentials, readers, retention policy, availability evidence, and poisoning
controls. A hit, upload, signature, or health signal in one plane says nothing
about the others.

### Publication admission

Artifact publication and production import are admitted only when the exact
child manifest and sealed admission bundle named by reviewed Nix configuration
pass the artifact-system bridge checks. The gate requires independent complete
pulls from two storage instances, restore and verification from a third
encrypted failure-domain archive, and network-disabled activation and rollback
of the already imported generation. A registry tag, OCI index match,
replication success, referrer listing, or healthy endpoint cannot satisfy any
of those gates.

Deletion and garbage collection are separate destructive capabilities. They
remain rejected until a pin- and rollback-derived live-set computation, dry-run
comparison, snapshot, bounded sweep, and post-sweep restore proof are all
independently observed.

## Second-Consumer Conformance

The first implementation publishes only contracts justified by a current
consumer. A second independently owned repository then proves the extraction
boundary by consuming versioned schemas and a versioned conformance corpus
through public interfaces. It supplies its own semantic declarations, aliases,
policy instances, and private system configuration.

Conformance must cover graph projection, invalidation locality, at least one
authoritative action, evidence joins, version negotiation, logical-label
relocation, platform-capability negotiation, and authority contraction. A
consumer importing private implementation paths, copying generated output
without its semantic source, or patching internals does not count.

The eventual publication repository and package boundary remain
[`BUCK-DQ1`](../spec.md#open-design-questions) until this proof exists. Shared
infrastructure must not depend on a consumer repository, preventing a reverse
dependency or bootstrap cycle.

## Complexity Criterion

For the admitted domain, verification compares semantic roles before and after
the authority change:

```text
producers + routers + schemas + launchers + user commands
```

Generated shards and evidence instances are data, not new abstractions.
Equivalent producers, parallel task graphs, fallback routers, duplicate schema
owners, and mandatory launchers are abstractions and block admission. The
result must have one producer and one primary developer interface; any retained
legacy surface must be provably outside the admitted domain.
