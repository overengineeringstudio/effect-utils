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
const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}
const round1 = (value) => Math.round(value * 10) / 10

const summary = JSON.parse(read('storage-sharing-default-v2.json'))
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

const platformInputs = {
  'x86_64-linux': {
    artifact: summary.measurementMethod.rawArtifacts.linux,
    summary: summary.platforms.find((item) => item.platform === 'x86_64-linux'),
  },
  'aarch64-darwin': {
    artifact: summary.measurementMethod.rawArtifacts.darwin,
    summary: summary.platforms.find((item) => item.platform === 'aarch64-darwin'),
  },
}

for (const [platform, input] of Object.entries(platformInputs)) {
  assertEqual(sha256(input.artifact.path), input.artifact.sha256, `${platform} raw digest`)
  const records = parseJsonl(input.artifact.path)
  const byPhase = new Map(records.map((record) => [record.phase, record]))
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
    assertEqual(raw.status, 'ok', `${platform} ${rawName} status`)
    assertEqual(raw.durationMs, value.durationMs, `${platform} ${rawName} duration`)
    assertEqual(raw.reused, value.reused, `${platform} ${rawName} reused`)
    assertEqual(raw.downloads, value.downloaded, `${platform} ${rawName} downloads`)
  }

  const concurrent = phase.concurrentRootsDAndE
  assertEqual(
    byPhase.get('concurrent-pair').durationMs,
    concurrent.durationMs,
    `${platform} concurrent duration`,
  )
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

  const shared = byPhase.get('size:shared-two-roots').sizes
  const isolated = byPhase.get('size:isolated-one-root').sizes
  const concurrentSize = byPhase.get('size:concurrent-two-roots').sizes
  for (const key of ['physicalKiB', 'apparentKiB', 'files']) {
    assertEqual(shared[key], input.summary.twoRootComparison.sharedMeasured[key], `${platform} shared ${key}`)
    assertEqual(
      isolated[key] * 2,
      input.summary.twoRootComparison.isolatedComparator[key],
      `${platform} isolated comparator ${key}`,
    )
    assertEqual(
      concurrentSize[key],
      concurrent.combinedStoreAndRoots[key],
      `${platform} concurrent ${key}`,
    )
    assertEqual(
      round1(((isolated[key] * 2 - shared[key]) / (isolated[key] * 2)) * 100),
      input.summary.twoRootComparison.improvementPercent[key],
      `${platform} improvement ${key}`,
    )
  }
  assertEqual(
    round1(((phase.isolatedRootC.durationMs - phase.secondSharedRootB.durationMs) / phase.isolatedRootC.durationMs) * 100),
    input.summary.twoRootComparison.improvementPercent.secondRootDuration,
    `${platform} second-root improvement`,
  )
  assertEqual(byPhase.get('correctness').concurrentRoots, 2, `${platform} concurrent roots`)
  assertEqual(
    byPhase.get('correctness').sigkill137Accepted,
    false,
    `${platform} SIGKILL policy`,
  )
}

for (const [host, capability] of Object.entries(summary.hostLifecycleCapability.hosts)) {
  assertEqual(sha256(capability.rawArtifact), capability.sha256, `${host} raw digest`)
  const [raw] = parseJsonl(capability.rawArtifact)
  assertEqual(raw.host, host, `${host} identity`)
  for (const key of [
    'rootNlink',
    'liveRootSurvivedPrune',
    'removedRootCacheEvicted',
    'destructivePruneSafe',
  ]) {
    assertEqual(raw[key], capability[key], `${host} ${key}`)
  }
}

console.log('storage-sharing-default-v2: ok')
