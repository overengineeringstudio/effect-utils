/** Fleet labels admitted by the workflow policy; Namespace runners remain legacy-only. */
export const fleetRunnerLabels = {
  linuxX64: 'sh-linux-x64',
  linuxX64Heavy: 'sh-linux-x64-heavy',
  linuxArm64: 'sh-linux-arm64',
  darwinArm64: 'sh-darwin-arm64',
  linuxX64Publish: 'sh-linux-x64-publish',
  linuxArm64Publish: 'sh-linux-arm64-publish',
  linuxX64AiGateway: 'sh-linux-x64-ai-gateway',
} as const

export type FleetRunnerLabel = (typeof fleetRunnerLabels)[keyof typeof fleetRunnerLabels]
export type FleetRunnerPlatform = 'x86_64-linux' | 'aarch64-linux' | 'aarch64-darwin'

export const fleetRunnerPlatforms = {
  [fleetRunnerLabels.linuxX64]: 'x86_64-linux',
  [fleetRunnerLabels.linuxArm64]: 'aarch64-linux',
  [fleetRunnerLabels.linuxX64Heavy]: 'x86_64-linux',
  [fleetRunnerLabels.darwinArm64]: 'aarch64-darwin',
  [fleetRunnerLabels.linuxX64Publish]: 'x86_64-linux',
  [fleetRunnerLabels.linuxArm64Publish]: 'aarch64-linux',
  [fleetRunnerLabels.linuxX64AiGateway]: 'x86_64-linux',
} as const satisfies Record<FleetRunnerLabel, FleetRunnerPlatform>

export const nixRunnerSelector = 'nix' as const

export const linuxX64Runner = [fleetRunnerLabels.linuxX64, nixRunnerSelector] as const
export const linuxArm64Runner = [fleetRunnerLabels.linuxArm64, nixRunnerSelector] as const
/** Served only by the dedicated heavy scale set; never mixed with generic selectors. */
export const linuxX64HeavyRunner = [fleetRunnerLabels.linuxX64Heavy] as const

export const darwinArm64Runner = [fleetRunnerLabels.darwinArm64, nixRunnerSelector] as const

/** Historical matrix values also used verbatim in required check names. Not fleet labels. */
export const LEGACY_RUNNER_PROFILES = [
  'namespace-profile-linux-x86-64',
  'namespace-profile-macos-arm64',
] as const

/** Compatibility name for historical matrix/check-name values, not policy admission. */
export const RUNNER_PROFILES = LEGACY_RUNNER_PROFILES
export type RunnerProfile = (typeof LEGACY_RUNNER_PROFILES)[number]

/** Legacy Namespace Linux machine for paired base/head Nix closures. */
export const LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER =
  'nscloud-ubuntu-24.04-amd64-16x64-with-features'

/** Labels needed by actionlint, including legacy runners; not a policy allowlist. */
export const selfHostedRunnerLabels = [
  ...new Set([
    ...LEGACY_RUNNER_PROFILES,
    ...linuxX64Runner,
    ...linuxArm64Runner,
    fleetRunnerLabels.linuxX64Publish,
    fleetRunnerLabels.linuxArm64Publish,
    ...darwinArm64Runner,
    LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER,
    `${LEGACY_NAMESPACE_LINUX_X64_PAIRED_PERF_RUNNER};job.priority=4`,
    fleetRunnerLabels.linuxX64Heavy,
    fleetRunnerLabels.linuxX64AiGateway,
  ]),
] as const
