# 2026-08-11 Exact Closure Architecture

## Question

Can shared immutable package bytes and target-local closure manifests preserve
pnpm semantics while preventing unrelated dependency state from invalidating a
Buck target?

## Method

### Resolver Experiment

- Used the repository-declared pnpm 11.8.0 implementation and lockfile v9
  semantics in an ignored disposable prototype.
- Parsed the full lock and computed closures for five mutation/platform cases
  across representative importers.
- Unrelated lock-node and unrelated `packageExtensionsChecksum` mutations kept
  the target closure digest stable.
- A traversed `effect@3.21.4` integrity mutation changed the digest.
- Linux x64 glibc versus Darwin arm64 selection changed the platform closure.
- Fifteen cold Node runs had median `0.571s`, range `0.475-1.007s`. This is
  suitable for generation/freshness checks, not for every hot-path invocation.
- Direct low-level lock filtering did not correctly follow all importer-relative
  workspace links. pnpm deploy conversion and isolated projection behavior must
  remain the parity oracle.
- The ambient shell resolved pnpm 11.3.0 while the repository declares 11.8.0;
  the canonical generator must use the pinned tool and fail on version drift.

### Buck Experiment

- Built an ignored synthetic Buck graph with a target-local closure manifest,
  exact declared package artifacts, and no ambient `node_modules`.
- Cold build executed two actions; the warm build executed zero.
- A valid unrelated manifest/package change executed zero actions.
- A relevant target manifest byte change executed exactly two actions.
- Omitting a package referenced by the manifest failed RED with exit 3 before
  the consumer ran; declaring the edge passed GREEN with two actions.
- An independent oracle confirmed the final projection contained exactly the
  two declared packages and excluded the unrelated package.
- Twenty direct warm builds after three warmups averaged `17.5ms` with `5.7ms`
  standard deviation and a `12.0-30.1ms` range on the shared host.

### Existing Prepared Artifact Measurement

Four realized Nix-prepared CLI dependency trees contained 1,081 package-context
references but only 320 unique locator names. Their NAR sizes totaled
958,423,936 bytes. A locator-level upper-bound estimate found 684,035,775 bytes
(72.8 percent) of repeated package-entry payload. Pairwise locator Jaccard
overlap ranged from 72.4 to 99.6 percent.

This strongly motivates shared payload blobs but is not a byte-hash equivalence
proof. The next producer prototype must normalize and hash payload contents.
Current realized prepared artifacts also contain `.bin` directories despite the
accepted strict-normalization contract, so they are a topology/policy oracle,
not a wholesale byte oracle.

## Result

The prototype proves target-local manifest invalidation and undeclared-edge
failure. It does not prove relocatable toolchains, remote-cache safety, or
cross-host replay: its action still used host shell/coreutils.

The resolver and prepared-artifact evidence support this model:

```text
PackageContentId
  normalized payload: integrity + affected patch + materializer ABI
          |
          v
PackageContextId
  full pnpm snapshot: payload + selected edges + peer bindings
          |
          v
TaskClosureId
  importer + task class + platform + roots + sorted contexts/providers
```

- Package bytes are Buck artifacts and use Buck local/remote CAS and GC.
- Context records preserve peer topology without duplicating equal bytes.
- Target manifests are sharded generated inputs; parsing the global lock does
  not place the global lock or a monolithic generated file in every action key.
- Workspace dependencies are Buck providers, context-qualified when injected
  peer resolution can affect their outputs.
- Whole-workspace projections remain an explicit compatibility fallback for
  tasks whose dynamic dependency surface cannot yet be declared.

## Admission Gates

Before authority or remote-cache writes, prove:

1. parity for peers, injected workspace dependencies, aliases, patches,
   extensions, overrides, optional/native packages, bins, dynamic/config/plugin
   access, and exact exec/target platform selection;
2. relevant RED/GREEN and irrelevant negative invalidation in warm, restarted,
   cross-worktree, and remote-cache lanes;
3. deterministic normalized payloads with no absolute, escaping, dangling, or
   ambient links;
4. separate public/private cache trust domains plus corruption and malicious
   action-result controls;
5. Buck artifact export to digest/provenance-verified Nix fixed-output import,
   including tamper and wrong-platform failures;
6. native Buck reports/logs joined to closure evidence without secrets or
   high-cardinality metric labels.

## Conclusion

Use the three-layer content/context/closure model. Generate target-local
manifests and exact Buck edges, use Buck's CAS for immutable package payloads,
and retain whole-workspace projections only as an explicit compatibility
fallback. Do not admit the design to authoritative or remote-cache use until
the listed parity, hermeticity, trust, and Nix-import gates pass.

## VRS Impact

- Amends decision 0003 to separate package payload, peer-context, and
  target-closure identities.
- Strengthens DMP.BUCK-R09 and adds DMP.BUCK-R10 through DMP.BUCK-R12 for
  layered keys, cache trust domains, and native evidence correlation.
- Does not change A01/A02: existing Nix materialization remains authority while
  the new producer is evidence-only.
