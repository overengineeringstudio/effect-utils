import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const read = (path) => readFileSync(join(directory, path), 'utf8')
const sha256 = (path) => createHash('sha256').update(read(path)).digest('hex')
const parseJsonl = (path) =>
  read(path)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
// Assertion helpers form a compact verification DSL; positional actual/expected/label
// call sites are more legible here than repeated object literals.
// oxlint-disable-next-line overeng/named-args
const assertEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
}
// oxlint-disable-next-line overeng/named-args
const assertTrue = (value, label) => assertEqual(value, true, label)
const round1 = (value) => Math.round(value * 10) / 10
const sizeKeys = ['physicalKiB', 'apparentKiB', 'files']
const installPhases = [
  'cold-root-a',
  'second-root-b',
  'warm-root-b',
  'isolated-root-c',
  'concurrent-root-d',
  'concurrent-root-e',
]
const sizePhases = [
  'cold-root-a-root-node-modules',
  'cold-root-a-store',
  'second-root-b-root-node-modules',
  'second-root-b-store',
  'shared-two-roots',
  'warm-root-b-root-node-modules',
  'warm-root-b-store',
  'isolated-root-c-root-node-modules',
  'isolated-root-c-store',
  'isolated-one-root',
  'concurrent-root-d-root-node-modules',
  'concurrent-root-d-store',
  'concurrent-root-e-root-node-modules',
  'concurrent-root-e-store',
  'concurrent-two-roots',
].map((name) => `size:${name}`)
const requiredPhases = [
  'provenance',
  ...installPhases,
  ...sizePhases,
  'concurrent-pair',
  'correctness',
]

const summary = JSON.parse(read('storage-sharing-default-v2.json'))
assertEqual(summary.schema, 'dependency-materialization-verification/v0', 'summary schema')
assertEqual(summary.kind, 'default-gate', 'summary kind')
assertEqual(summary.surface, 'storage-sharing', 'summary surface')
assertEqual(summary.policy.packageStoreScope, 'host-user', 'package store scope')
assertEqual(summary.policy.virtualStoreScope, 'materialization-root', 'virtual store scope')
assertEqual(summary.policy.packageImportMethod, 'auto', 'import method')
assertEqual(summary.policy.enableGlobalVirtualStore, false, 'GVS policy')
assertEqual(
  sha256('measure-storage-sharing-default.sh'),
  summary.measurementMethod.harness.sha256,
  'storage harness digest',
)
assertEqual(
  sha256('measure-prune-capability.sh'),
  summary.hostLifecycleCapability.harness.sha256,
  'prune harness digest',
)
const expectedPnpm = summary.measurementMethod.packageManager.replace(/^pnpm@/, '')
const platformInputs = {
  'x86_64-linux': {
    artifact: summary.measurementMethod.rawArtifacts.linux,
    summary: summary.platforms.find((item) => item.platform === 'x86_64-linux'),
    filesystem: 'ext4',
    sourceMode: 'git-worktree',
  },
  'aarch64-darwin': {
    artifact: summary.measurementMethod.rawArtifacts.darwin,
    summary: summary.platforms.find((item) => item.platform === 'aarch64-darwin'),
    filesystem: 'apfs',
    sourceMode: 'verified-git-archive-tree',
  },
}
assertEqual(summary.platforms.length, Object.keys(platformInputs).length, 'platform count')

for (const [platform, input] of Object.entries(platformInputs)) {
  assertTrue(input.summary !== undefined, `${platform} summary exists`)
  assertEqual(input.summary.status, 'ok', `${platform} summary status`)
  assertEqual(
    input.summary.environment.filesystem,
    input.filesystem,
    `${platform} summary filesystem`,
  )
  assertEqual(sha256(input.artifact.path), input.artifact.sha256, `${platform} raw digest`)
  const records = parseJsonl(input.artifact.path)
  const byPhase = new Map(records.map((record) => [record.phase, record]))
  assertEqual(byPhase.size, records.length, `${platform} unique phases`)
  assertEqual(records.length, requiredPhases.length, `${platform} record count`)
  for (const phaseName of requiredPhases)
    assertTrue(byPhase.has(phaseName), `${platform} ${phaseName}`)
  for (const record of records) {
    assertEqual(record.schema, summary.schema, `${platform} ${record.phase} schema`)
    assertEqual(record.kind, 'benchmark', `${platform} ${record.phase} kind`)
    assertEqual(record.surface, summary.surface, `${platform} ${record.phase} surface`)
    assertEqual(record.platform, platform, `${platform} ${record.phase} platform`)
    assertEqual(record.status, 'ok', `${platform} ${record.phase} status`)
  }

  const provenance = byPhase.get('provenance')
  assertEqual(
    provenance.implementationHead,
    summary.measurementMethod.implementationHead,
    `${platform} implementation head`,
  )
  assertEqual(
    provenance.implementationTree,
    summary.measurementMethod.implementationTree,
    `${platform} implementation tree`,
  )
  assertEqual(
    provenance.harnessSha256,
    summary.measurementMethod.harness.sha256,
    `${platform} harness provenance`,
  )
  assertEqual(provenance.sourceMode, input.sourceMode, `${platform} source mode`)
  assertEqual(provenance.filesystem, input.filesystem, `${platform} raw filesystem`)
  assertEqual(provenance.pnpm, expectedPnpm, `${platform} pnpm`)
  assertEqual(provenance.node, input.summary.environment.node, `${platform} node`)

  const phase = input.summary.phaseMatrix
  const mappings = [
    ['coldSharedRootA', 'cold-root-a'],
    ['secondSharedRootB', 'second-root-b'],
    ['warmSharedRootB', 'warm-root-b'],
    ['isolatedRootC', 'isolated-root-c'],
  ]
  for (const [summaryName, rawName] of mappings) {
    const raw = byPhase.get(rawName)
    const value = phase[summaryName]
    assertEqual(raw.durationMs, value.durationMs, `${platform} ${rawName} duration`)
    assertEqual(raw.reused, value.reused, `${platform} ${rawName} reused`)
    assertEqual(raw.downloads, value.downloaded, `${platform} ${rawName} downloads`)
    const acceptedAbort = raw.teardownExit === 134 && raw.completedMaterializationEvidence === true
    assertTrue(
      (raw.teardownExit === 0 && raw.completedMaterializationEvidence === false) || acceptedAbort,
      `${platform} ${rawName} teardown semantics`,
    )
    if (platform === 'aarch64-darwin') {
      assertEqual(raw.teardownExit, value.teardownExit, `${platform} ${rawName} teardown exit`)
      assertEqual(
        raw.completedMaterializationEvidence,
        value.completedMaterializationEvidence ?? false,
        `${platform} ${rawName} completion evidence`,
      )
    } else {
      assertEqual(raw.teardownExit, 0, `${platform} ${rawName} teardown exit`)
    }
  }
  for (const rawName of ['concurrent-root-d', 'concurrent-root-e']) {
    const raw = byPhase.get(rawName)
    assertEqual(raw.teardownExit, 0, `${platform} ${rawName} teardown exit`)
    assertEqual(
      raw.completedMaterializationEvidence,
      false,
      `${platform} ${rawName} completion evidence`,
    )
  }

  const concurrent = phase.concurrentRootsDAndE
  const concurrentPair = byPhase.get('concurrent-pair')
  assertEqual(concurrentPair.roots, 2, `${platform} concurrent pair roots`)
  assertEqual(concurrentPair.durationMs, concurrent.durationMs, `${platform} concurrent duration`)
  assertEqual(
    byPhase.get('concurrent-root-d').durationMs,
    concurrent.rootDDurationMs,
    `${platform} concurrent root D duration`,
  )
  assertEqual(
    byPhase.get('concurrent-root-e').durationMs,
    concurrent.rootEDurationMs,
    `${platform} concurrent root E duration`,
  )
  for (const name of ['concurrent-root-d', 'concurrent-root-e']) {
    assertEqual(byPhase.get(name).reused, concurrent.eachReused, `${platform} ${name} reused`)
    assertEqual(
      byPhase.get(name).downloads,
      concurrent.eachDownloaded,
      `${platform} ${name} downloads`,
    )
  }

  for (const name of sizePhases) {
    for (const key of sizeKeys) {
      assertTrue(
        Number.isSafeInteger(byPhase.get(name).sizes[key]),
        `${platform} ${name} ${key} integer`,
      )
      assertTrue(byPhase.get(name).sizes[key] > 0, `${platform} ${name} ${key} positive`)
    }
  }
  const sizeMappings = [
    ['size:cold-root-a-root-node-modules', phase.coldSharedRootA.rootNodeModules],
    ['size:cold-root-a-store', phase.coldSharedRootA.store],
    ['size:isolated-one-root', phase.isolatedRootC.combinedStoreAndRoot],
    ['size:shared-two-roots', input.summary.twoRootComparison.sharedMeasured],
    ['size:concurrent-two-roots', concurrent.combinedStoreAndRoots],
  ]
  for (const [rawName, value] of sizeMappings) {
    for (const key of sizeKeys) {
      assertEqual(byPhase.get(rawName).sizes[key], value[key], `${platform} ${rawName} ${key}`)
    }
  }
  const isolated = byPhase.get('size:isolated-one-root').sizes
  const shared = byPhase.get('size:shared-two-roots').sizes
  for (const key of sizeKeys) {
    assertEqual(
      isolated[key] * 2,
      input.summary.twoRootComparison.isolatedComparator[key],
      `${platform} isolated comparator ${key}`,
    )
    assertEqual(
      round1(((isolated[key] * 2 - shared[key]) / (isolated[key] * 2)) * 100),
      input.summary.twoRootComparison.improvementPercent[key],
      `${platform} improvement ${key}`,
    )
  }
  assertEqual(
    round1(
      ((phase.isolatedRootC.durationMs - phase.secondSharedRootB.durationMs) /
        phase.isolatedRootC.durationMs) *
        100,
    ),
    input.summary.twoRootComparison.improvementPercent.secondRootDuration,
    `${platform} second-root improvement`,
  )

  const correctness = byPhase.get('correctness')
  for (const key of [
    'distinctVirtualStores',
    'concurrentRoots',
    'ignoreScriptsConfigured',
    'sigkill137Accepted',
  ]) {
    assertEqual(
      correctness[key],
      input.summary.correctness[key] ?? false,
      `${platform} correctness ${key}`,
    )
  }
  assertEqual(correctness.distinctVirtualStores, true, `${platform} distinct virtual stores`)
  assertEqual(correctness.concurrentRoots, 2, `${platform} concurrent roots`)
  assertEqual(correctness.ignoreScriptsConfigured, true, `${platform} ignore scripts configuration`)
  assertEqual(correctness.sigkill137Accepted, false, `${platform} SIGKILL policy`)
}

for (const [host, capability] of Object.entries(summary.hostLifecycleCapability.hosts)) {
  assertEqual(sha256(capability.rawArtifact), capability.sha256, `${host} raw digest`)
  const records = parseJsonl(capability.rawArtifact)
  assertEqual(records.length, 1, `${host} record count`)
  const [raw] = records
  assertEqual(raw.schema, summary.schema, `${host} schema`)
  assertEqual(raw.kind, 'host-capability', `${host} kind`)
  assertEqual(raw.surface, 'pnpm-store-prune', `${host} surface`)
  for (const key of [
    'host',
    'platform',
    'filesystem',
    'pnpm',
    'rootBase',
    'storeBase',
    'rootDevice',
    'storeDevice',
    'rootNlink',
    'liveRootSurvivedPrune',
    'removedRootCacheEvicted',
    'destructivePruneSafe',
  ]) {
    assertEqual(raw[key], capability[key] ?? host, `${host} ${key}`)
  }
  assertEqual(raw.pnpm, expectedPnpm, `${host} deployed pnpm version`)
  assertTrue(raw.pnpmBin.endsWith(`-pnpm-${expectedPnpm}/bin/pnpm`), `${host} pnpm derivation`)
  assertEqual(raw.packageImportMethod, summary.policy.packageImportMethod, `${host} import method`)
  assertEqual(raw.rootDevice, raw.storeDevice, `${host} same device`)
  assertTrue(raw.rootNlink >= 2, `${host} hardlink count`)
  assertEqual(raw.storeAliasFound, true, `${host} store inode alias`)
  assertEqual(raw.beforeKiB, raw.afterLivePruneKiB, `${host} live-root prune preserves cache`)
  assertTrue(
    raw.afterRemovedPruneKiB < raw.afterLivePruneKiB,
    `${host} removed-root prune reclaims cache`,
  )
  assertEqual(raw.liveRootSurvivedPrune, true, `${host} live root survives`)
  assertEqual(raw.removedRootCacheEvicted, true, `${host} removed root evicted`)
  assertEqual(raw.destructivePruneSafe, true, `${host} destructive prune safety`)
}

console.log('storage-sharing-default-v2: ok')
