# Cross-Repository Composition Architecture Bakeoff

Date: 2026-09-13. Producer: effect-utils. Consumer: dotfiles `@dotfiles/notion-scan`. Edge under test: `@overeng/utils/node/cli-help-rewrite`. pnpm 12.4.1, TypeScript 7.0.2, Vitest 4.1.9. This is decision evidence, not merged product code.

## Question

Which long-term composition model gives cross-repository reuse and correct invalidation without keeping more standing machinery than the observed use needs?

The same consumer edge must typecheck and run an existing unit test in each surviving mode. Numbers below state the command and sample count. The [prior-art record](../.reference/2026-09-13-cross-repo-reuse-prior-art.md) supplies source-verified mechanism contracts.

## Candidates

### A. Composed Buck2 cells

Keep decisions 0014/0020/0027: source repositories are cells in one generated root; producer source and targets participate in the consumer action graph; shared RE action results provide reuse.

Expected strengths: source-granular invalidation, action-level reuse, one edit/test graph. Expected costs: generated root plus acquisition, one-writer mount projection, update lock, capability projection, overlays, daemon isolation, and recovery state.

### B. Artifact-default libraries

Publish each cross-repository TypeScript library as an immutable scoped package. The consumer lock pins scope/name/version plus registry integrity. A parent-specific root override supports migration while other consumers retain the broad source override. Producer actions stop at the package boundary; the consumer graph sees installed declarations/JavaScript.

Required completion beyond the prototype: a package manifest transformed through pnpm's pack contract; a publisher that accepts scoped package identity; immutable registry retention; provenance; and closure rejection for unresolved runtime `workspace:`, `link:`, or `file:` specs.

### C. Hybrid: cells for forks, artifacts for ordinary libraries

Use candidate B for `@overeng/utils` and ordinary library edges. Keep source mounts for active overeng/livestore fork co-development and generator-source imports. The candidate originally retained Buck cells for forks; the complexity ledger falsifies that default. A fork can keep an L2 source mount and package/editor edge without making it a cell in every consumer Buck graph.

### D. Nix flake package outputs

Ruled out before implementation as a universal TypeScript-library model. Flake lock plus output attribute plus system is a strong identity for Nix-native executables. It does not supply npm package metadata, pnpm peer/closure resolution, or ordinary TypeScript editor resolution. It remains a narrow winner for Nix-consumed products.

Buck2 Git external cells, Bazel Bzlmod, Nx/Turborepo cache, git submodules/worktrees, and Josh were research controls rather than separate prototypes. They respectively provide pinned source, module resolution, task-result transport, or checkout/history views. None eliminates the package publication boundary for this edge.

## Fixture

A throwaway dotfiles worktree at `origin/main` materialized effect-utils at the consumer lock pin. No consumer branch was pushed. The candidate-B archive reused the `@overeng/utils` Buck dist from draft PR #1282, branch `schickling-assistant/2026-09-12-artifact-spikes`; this record does not duplicate its target or publisher code.

PR #1282 produced a package archive from the Buck dist in one fresh build (n=1, command `devenv tasks run -m single buck2:package-overeng-utils`, 146.5 s wall). The spike also proved that the existing publisher rejects a scoped package name and that the archive retained two `workspace:^` runtime dependencies. Those are real implementation failures, not prototype setup noise.

For the consumer-resolution experiment only, an in-memory tar transform:

1. rewrote `@overeng/effect-distributed-lock` and `@overeng/otel-contract` runtime specs from `workspace:^` to `0.1.0`;
2. aligned Effect 4 peer/runtime specs with the consumer's `4.0.0-rc.111` contract;
3. retained the Buck-built `dist/src/**` and dist-only exports;
4. normalized archive metadata and named the result by its digest, `sha256:6cda0b4a…6962e` (`sha256sum tmp/artifacts/overeng-utils-6cda0b4ad5f54b6e.tgz`, n=1).

This hand transform proves consumer mechanics only. A production artifact must get the same result from the generated manifest plus `pnpm pack` and reject hand edits.

The one-line mixed-mode selector was:

```yaml
'@dotfiles/notion-scan>@overeng/utils': 'file:tmp/artifacts/overeng-utils-6cda0b4ad5f54b6e.tgz'
```

The broad root override for `@overeng/utils` continued to point at source, so other packages stayed in source mode. A registry version is the production equivalent; the local file fixture avoids publishing experimental bytes.

## Correctness Results

### Source/composed edge

With the parent-specific override absent, notion-scan resolved its existing generated `link:` edge into the materialized effect-utils source. These commands passed:

```sh
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
CI=1 ../../node_modules/.bin/vitest run tests/unit/fingerprint.test.ts
```

The source-mode command reported 1 file and 28 tests passed (n=1). This proves the same user-level edge in source mode. Dotfiles does not yet author a Buck target for notion-scan on `main`, so a second disposable two-cell root exercised the missing build-system boundary. Its producer cell exported the byte-identical `cli-help-rewrite.ts`; its dotfiles-shaped consumer cell copied that cross-cell source into one action, typechecked a consumer import, ran a Bun unit test of `rewriteHelpSubcommand`, and wrote a stamp. The exact build command, from `tmp/composition-cell-probe`, was:

```sh
time -p ../../.devenv/profile/bin/buck2 --isolation-dir composition-bakeoff \
  build consumer//:verify --target-platforms root//:default
```

The complete disposable fixture was:

```sh
mkdir -p tmp/composition-cell-probe/{producer,consumer,toolchains,none}
cp packages/@overeng/utils/src/node/cli-help-rewrite.ts \
  tmp/composition-cell-probe/producer/cli-help-rewrite.ts
touch tmp/composition-cell-probe/{.buckroot,none/BUCK}
realpath .devenv/profile/bin/{tsc,bun}
```

`.buckconfig`:

```ini
[cells]
  root = .
  producer = producer
  consumer = consumer
  prelude = prelude
  none = none
  toolchains = toolchains

[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude

[external_cells]
  prelude = bundled

[buck2]
  digest_algorithms = SHA256
```

Root `BUCK`:

```python
platform(
    name = "default",
    constraint_values = [],
    visibility = ["PUBLIC"],
)
```

`toolchains/BUCK`:

```python
load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")

system_genrule_toolchain(
    name = "genrule",
    visibility = ["PUBLIC"],
)
```

`producer/BUCK`:

```python
export_file(
    name = "utils_source",
    src = "cli-help-rewrite.ts",
    visibility = ["PUBLIC"],
)
```

`consumer/consumer.ts`:

```ts
import { rewriteHelpSubcommand } from './utils.js'

export const observed = rewriteHelpSubcommand(['help', 'status'])
```

`consumer/consumer.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { rewriteHelpSubcommand } from './utils.js'

test('rewrites the help subcommand', () => {
  expect(rewriteHelpSubcommand(['help', 'status'])).toEqual(['status', '--help'])
})
```

`consumer/BUCK`, with `<TSC>` and `<BUN>` replaced by the two `realpath` outputs above so tool identity is immutable:

```python
export_file(name = "consumer_source", src = "consumer.ts")
export_file(name = "consumer_test", src = "consumer.test.ts")

genrule(
    name = "verify",
    srcs = [":consumer_source", ":consumer_test", "producer//:utils_source"],
    out = "verified.txt",
    cmd = """
      cp $(location producer//:utils_source) $TMP/utils.ts
      cp $(location :consumer_source) $TMP/consumer.ts
      cp $(location :consumer_test) $TMP/consumer.test.ts
      OUT_ABS=$PWD/$OUT
      TSC=<TSC>
      BUN=<BUN>
      cd $TMP
      $TSC --strict --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext consumer.ts
      $BUN test consumer.test.ts
      printf ok > $OUT_ABS
    """,
)
```

The target passed both TypeScript and one unit test inside the Buck action. Three successive producer edits each caused exactly one local consumer action; restoring bytes was also detected. The scratch root intentionally had no RE client, so it proves cross-cell dispatch and invalidation, not shared-cache reuse.

### Artifact edge

With the parent-specific override present, pnpm wrote the artifact spec into the notion-scan importer and wrote SHA-512 integrity for the digest-named local tarball. The installed manifest's exports pointed to `dist/src/**`, and both commands above passed. The same existing test again reported 1 file and 28 tests passed (n=1).

Four failure controls mattered:

1. The unmodified PR archive failed strict installation because its Effect 4 peers were `rc.112` while the consumer was `rc.111`. Package identity must carry a compatible peer contract; source-path tolerance is not evidence that an artifact is compatible.
2. The first archive retained two runtime `workspace:^` dependencies. An independently installed archive cannot resolve those outside its producer workspace.
3. Replacing bytes at the same local `file:` path did not update the lock entry; even `pnpm install --force` reported the lock up to date. Changing to a digest-named path caused the expected lock mismatch and new integrity. A mutable filename is not artifact identity.
4. PR #1282's direct-URL experiment failed with `ERR_PNPM_EXOTIC_SUBDEP` under pnpm's default `blockExoticSubdeps`; a second attempt that removed the broad source override broke remaining `workspace:` consumers. A trusted registry version is therefore the production choice. A direct GitHub Release URL is not the default package transport.

The consumer had unrelated pre-existing strict peer drift in `@overeng/tui-react`, `@overeng/genie`, and `@overeng/notion-react`. Artifact-specific peer failures disappeared after alignment. Measurements used `--strict-peer-dependencies=false` only to isolate those unrelated baseline failures and list them explicitly; production gates must stay strict.

### Producer edit control

A reversible newline was appended to `packages/@overeng/utils/src/node/cli-help-rewrite.ts`; `sha256sum packages/@overeng/utils/src/node/cli-help-rewrite.ts` changed from `04eb7cb1…e94` to `bd9131db…291b` (n=1 before/after). The artifact consumer lock and installed artifact did not change, and the producer file was restored byte-for-byte. This is the intended artifact boundary: an unpublished producer edit cannot invalidate a consumer. Candidate A would include the changed source in affected action inputs; candidate B requires a new immutable package identity.

## Timing

All pnpm timing commands used the shared store required by the investigation:

```sh
PNPM_STORE_DIR=<shared-store> PNPM_CONFIG_STORE_DIR=<shared-store> CI=1 \
  time -p .devenv/profile/bin/pnpm install --ignore-scripts \
  --frozen-lockfile --strict-peer-dependencies=false
```

`fresh context` below means `node_modules` removed while retaining the shared store, then the same frozen command. `unchanged` retains both. Samples are wall-clock `real` seconds, n=3, sequential on one worktree.

| Candidate / state                         |      Samples (s) | Median | Cache observation                                   |
| ----------------------------------------- | ---------------: | -----: | --------------------------------------------------- |
| Artifact, unchanged                       | 0.75, 0.87, 0.67 | 0.75 s | 850 packages reused, 0 downloaded                   |
| Artifact, fresh context                   | 1.13, 0.99, 0.86 | 0.99 s | 883 packages materialized; 850 reused, 0 downloaded |
| Artifact, after unpublished producer edit | 0.86, 0.76, 0.68 | 0.76 s | Same artifact identity; 850 reused, 0 downloaded    |

Changing the source/artifact selector is a full lock-resolution event, not the steady-state loop: artifact → source was 68.21 s (n=1) and source → artifact was 117.11 s (n=1) with the command above changed to `--no-frozen-lockfile`. These two one-off values are noisy under the active host CPU incident and are not a comparative benchmark.

Typecheck command:

```sh
time -p ../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

| Edge mode |      Samples (s) | Median | Note                                       |
| --------- | ---------------: | -----: | ------------------------------------------ |
| Source    | 1.39, 0.56, 0.57 | 0.57 s | First sample paid incremental-state update |
| Artifact  | 6.61, 0.66, 0.42 | 0.66 s | First sample paid edge-shape update        |

These n=3 samples show no material steady-state typecheck difference at this scale. The separate scratch target measures the Buck cell boundary:

| Cell state                            |       Samples (s) | Median | Action observation                                    |
| ------------------------------------- | ----------------: | -----: | ----------------------------------------------------- |
| Unchanged, warm daemon                |  0.06, 0.08, 0.05 | 0.06 s | No action executed                                    |
| Fresh isolation                       |  1.94, 1.66, 1.89 | 1.89 s | One local action per sample; RE not configured        |
| One distinct producer edit per sample | 9.56, 6.20, 18.06 | 9.56 s | One local consumer action per edit; RE not configured |

All rows use the exact Buck command above; fresh samples substituted isolation names `composition-bakeoff-fresh-1` through `-3`, and edit samples kept the warm isolation while changing only the producer comment. Samples are wall-clock `real`, n=3. The active host CPU incident makes the edit row noisy; action counts, not its latency, establish invalidation.

The accepted decision-0027 record reports fresh warm-cache composition 30.6 s, unchanged apply 0.20 s, 100% cross-worktree cache hits, and a 69 s cold daemon connection. The source record does not preserve commands or sample counts, so this bakeoff treats those as prior qualitative evidence and does not reuse them as statistical measurements.

## Machinery and Refactor Ledger

Production LOC was counted by reading every `*.ts` under `packages/@overeng/megarepo/src/composition/` and excluding names containing `.test.`: 14,408 lines in 19 files (n=1 repository snapshot). The exact calculation was:

```sh
bun -e "const g=new Bun.Glob('packages/@overeng/megarepo/src/composition/**/*.ts'); let lines=0,files=0; for await (const p of g.scan('.')) if (!p.includes('.test.')) { lines+=(await Bun.file(p).text()).split('\\n').length-1; files++ }; console.log(JSON.stringify({files,lines}))"
```

The semantic file list is recorded in the proposed decision's deletion ledger. This number excludes composition branches in CLI/config files and all scripts, so it is a lower bound on L3 standing machinery. It is not a promised net deletion.

PR #1282 contains the reusable URL-closure, capability-ownership, and package-packing spikes, plus tests; it does not complete a durable scoped publisher. The combined PR diff is not treated as the artifact lane's marginal cost. The one consumer prototype added one override line and no shipped source file.

Measured command-only artifact adoption from a ready compatible archive was: one override edit, one lock update, typecheck, and one unit-test command. The timing tables above cover repeated operations. Human refactor minutes were not instrumented, so no human-duration number is claimed. Production adds publish/provenance and generated-manifest edits before those four consumer steps.

Breaking refactor flows:

- **A:** edit producer and consumer in one composed root, run the graph, commit producer, repin, commit consumer. Fast local proof; Git publication is still two repositories.
- **B:** add compatibility in producer, publish immutable version, update consumer lock/API, then remove compatibility after all consumers adopt. More steps, but each repository remains reproducible during staggered rollout.
- **C:** use B for package APIs; use a named source mount only while a fork/generator change genuinely needs joint source. It must not silently become the default graph shape.

## Operational Comparison

| Concern          | A: cells                                                                                      | B: artifacts                                                | C: narrowed hybrid                           |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Identity         | cell/target/configuration/action inputs                                                       | scope/name/version + integrity                              | explicit per-edge source or package identity |
| Invalidation     | source/action granular                                                                        | package/lock granular                                       | per selected edge                            |
| Durable origin   | Git for source; RE is cache                                                                   | immutable package registry                                  | Git plus registry                            |
| Recovery surface | root generation, mount generation, update lock, capability projection, overlay, daemon, cache | publication, registry, consumer lock                        | both, but cell machinery only if retained    |
| Editor           | rich source navigation; coordinated checkout                                                  | installed declarations; standalone clone                    | source only for named exception              |
| Two writers      | one owned mount plus projection protocol; Git commits still separate                          | immutable package version; independent consumer locks       | separate mechanisms                          |
| Observability    | detailed typed composition phases, but many states                                            | standard publish/install identity; provenance must be added | highest total state if both permanent        |

During this bakeoff, a fresh `devenv tasks run mr:setup` for the assigned effect-utils worktree produced no terminal phase output until the retained PTY was explicitly stopped. The host had an active CPU-oversubscription incident. This is one operational observation (`pty stats effect-utils.composition-bakeoff.mr-setup-proof`, repeated snapshots), not a composition timing sample and not proof of deadlock. The executable cross-cell probe therefore used a minimal disposable root instead of waiting for the generated root.

## Criterion Winners

| Criterion                                | Winner                                              |
| ---------------------------------------- | --------------------------------------------------- |
| Standing machinery                       | B, provisional pending BUCK-R15                     |
| End-to-end incremental delta             | A                                                   |
| Correctness of invalidation              | A                                                   |
| Shared-cache efficiency                  | A                                                   |
| One-shot cross-repository refactor proof | A                                                   |
| Staggered breaking-refactor rollout      | B                                                   |
| Durability/provenance                    | B, contingent on immutable registry/provenance gate |
| Local editor/standalone ergonomics       | B                                                   |
| Multi-agent/multi-worktree behavior      | B                                                   |
| Operational observability/recovery       | B after publisher completion                        |
| Active fork co-development               | C's named source exception                          |
| Nix-native executable delivery           | D, narrow only                                      |

**Provisional overall winner: B, artifact-default libraries, with C narrowed to L2 source mounts for named fork/generator exceptions.** Candidate A wins more performance/correctness criteria. B has the measured gross deletion opportunity, but the artifact lane's permanent publisher, registry, provenance, and migration costs are not implemented or counted. Decision 0031 therefore blocks acceptance until a BUCK-R15 ledger proves lower **net** standing complexity while counting retained L3 in full during coexistence.

## Falsifiers Before Acceptance or First Adoption

1. A real consumer demonstrates that package-granular invalidation or publish latency blocks its normal loop and that an L2 source override cannot cover development.
2. The scoped publisher cannot make scope/name/version immutable with durable retention and provenance using the selected registry.
3. `pnpm pack` cannot produce the verified archive without a custom parallel manifest contract.
4. Before acceptance, a BUCK-R15 ledger must count permanent registry, publisher, provenance, package-closure, migration, and retained-L3 machinery against concrete deletions. If the net gate does not pass, reject B.
5. The artifact closure requires publishing a large inseparable package graph whose net machinery meets or exceeds retained L3.
6. A measured downstream Buck target gets enough action-level cross-repository reuse to pay the deletion-ledger difference.

## Prototype Disposition

No prototype code is proposed for merge. The disposable dotfiles worktree, local archives, two-cell probe, and private Buck daemons were removed after measurement; no consumer branch was pushed. PR #1282 remains draft and is the sole branch containing its spike implementation. The proposed decision records required follow-up; accepted VRS remains unchanged.
