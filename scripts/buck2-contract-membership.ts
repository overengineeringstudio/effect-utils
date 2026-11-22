import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Filename selection semantics carried by the immutable quick-contract catalog. */
export type ContractMembership = {
  readonly membership: readonly string[]
  readonly membership_mode: 'tracked' | 'tracked-and-untracked'
}

type MembershipSpecification = {
  readonly schemaVersion: 1
  readonly contracts: Readonly<Record<string, ContractMembership>>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

/** Decode the immutable selected-task catalog projection, never live source bytes. */
export const decodeMembershipSpecification = (value: unknown): MembershipSpecification => {
  if (
    record(value) === false ||
    value['schemaVersion'] !== 1 ||
    record(value['contracts']) === false
  )
    throw new Error(
      'quick-contracts: invalid membership-inputs.json schema (expected schemaVersion 1)',
    )
  const contracts: Record<string, ContractMembership> = Object.create(null)
  const keys = new Set<string>()
  for (const [task, spec] of Object.entries(value['contracts'])) {
    const key = task.replaceAll(':', '-')
    if (
      /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/u.test(task) === false ||
      keys.has(key) === true ||
      record(spec) === false ||
      Array.isArray(spec['membership']) === false ||
      spec['membership'].length === 0 ||
      spec['membership'].every(
        (path: unknown) => typeof path === 'string' && path !== '' && path.includes('\0') === false,
      ) === false ||
      (spec['membership_mode'] !== 'tracked' && spec['membership_mode'] !== 'tracked-and-untracked')
    )
      throw new Error(`quick-contracts: invalid membership specification for ${task}`)
    keys.add(key)
    contracts[task] = {
      membership: [...new Set<string>(spec['membership'])].toSorted(),
      membership_mode: spec['membership_mode'],
    }
  }
  return { schemaVersion: 1, contracts }
}

/** Git itself declares the hook-local variables to clear, matching without-git-local-env.sh. */
export const membershipGitEnvironment = ({
  git,
  root,
  env,
}: {
  readonly git: string
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
}): NodeJS.ProcessEnv => {
  const localVariables = execFileSync(git, ['rev-parse', '--local-env-vars'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const clean = { ...env }
  for (const variable of localVariables.trim().split('\n')) delete clean[variable]
  return clean
}

/** A census cache belongs to this one invocation only; no index/HEAD/result cache. */
export const contractMembershipDigests = ({
  specification,
  root,
  git,
  env,
}: {
  readonly specification: MembershipSpecification
  readonly root: string
  readonly git: string
  readonly env: Readonly<Record<string, string | undefined>>
}): Record<string, string> => {
  const digests: Record<string, string> = Object.create(null)
  const censuses = new Map<string, string>()
  const clean = membershipGitEnvironment({ git, root, env })
  for (const [task, spec] of Object.entries(specification.contracts).toSorted()) {
    const membership = [...new Set(spec.membership)].toSorted()
    const group = JSON.stringify([spec.membership_mode, membership])
    let digest = censuses.get(group)
    if (digest === undefined) {
      const names = execFileSync(
        git,
        [
          '-C',
          root,
          'ls-files',
          '-z',
          '--cached',
          ...(spec.membership_mode === 'tracked-and-untracked'
            ? ['--others', '--exclude-standard']
            : []),
          '--',
          ...membership,
        ],
        {
          env: clean,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
        },
      )
      const members = [...new Set(names.split('\0').filter((name) => name !== ''))].toSorted()
      digest = createHash('sha256')
        .update(
          JSON.stringify({
            schemaVersion: 1,
            membership_mode: spec.membership_mode,
            membership,
            members,
          }),
        )
        .digest('hex')
      censuses.set(group, digest)
    }
    digests[`quick_contracts.membership_${task.replaceAll(':', '-')}`] = digest
  }
  return digests
}

/** Only the prepared owning root acquires Git discovery; foreign cells may inherit its profile. */
export const profileContractMembershipDigests = ({
  root,
  env,
}: {
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
}): Record<string, string> => {
  const profile = env['WORKTREE_CAPABILITIES_PROFILE']
  if (profile === undefined || profile === '') return {}
  const directory = join(profile, 'quick-contracts')
  try {
    lstatSync(directory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
  const receipt = join(root, '.devenv', 'quick-contracts-prepared')
  let prepared: readonly string[]
  try {
    prepared = readFileSync(receipt, 'utf8').split('\n')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
  const [authority, preparedProfile] = prepared
  if (
    authority === undefined ||
    isAbsolute(authority) === false ||
    preparedProfile === undefined ||
    isAbsolute(preparedProfile) === false
  )
    throw new Error(`quick-contracts: malformed prepared receipt: ${receipt}`)
  if (realpathSync(preparedProfile) !== realpathSync(profile))
    throw new Error(`quick-contracts: selected profile does not match prepared root: ${receipt}`)
  const path = join(directory, 'share', 'membership-inputs.json')
  let specification: MembershipSpecification
  try {
    specification = decodeMembershipSpecification(JSON.parse(readFileSync(path, 'utf8')))
  } catch (cause) {
    throw new Error(
      `quick-contracts: required membership specification is missing or malformed: ${path}`,
      { cause },
    )
  }
  if (Object.keys(specification.contracts).length === 0) return {}
  const git = env['WORKTREE_GIT']
  if (git === undefined || isAbsolute(git) === false)
    throw new Error('quick-contracts: WORKTREE_GIT must name the declared absolute Git executable')
  return contractMembershipDigests({ specification, root, git, env })
}
