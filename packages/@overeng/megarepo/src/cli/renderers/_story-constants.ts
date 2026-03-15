/**
 * Shared constants for Storybook fixtures across all renderers.
 *
 * Single source of truth for anonymized workspace/member data used in stories.
 * All renderer-specific `_fixtures.ts` files should import from here.
 *
 * Store path convention: `~/.megarepo/github.com/<owner>/<repo>/refs/heads/<branch>/`
 *
 * Workspace structure (inspired by a real megarepo setup):
 *   dev-workspace (root)
 *   ├── dotfiles       (personal)
 *   ├── homepage        (personal)
 *   ├── core-lib        (personal)
 *   ├── dev-tools       (megarepo → cli-framework, ui-kit)
 *   ├── app-platform    (megarepo → examples)
 *   └── studio-org      (org)
 */

/** Megarepo store base path */
export const STORE_BASE = '/Users/dev/.megarepo' as const

/** Helper to construct a valid store worktree path */
export const storePath = ({ source, ref }: { source: string; ref: string }) =>
  `${STORE_BASE}/github.com/${source}/refs/heads/${ref}/` as const

/** Default workspace used in most stories */
export const WORKSPACE = {
  name: 'dev-workspace',
  root: storePath({ source: 'alice/dev-workspace', ref: 'main' }),
} as const

/** CI workspace used in apply/deploy stories */
export const CI_WORKSPACE = {
  name: 'dev-workspace-blue',
  root: '/home/runner/.megarepo/github.com/alice/dev-workspace-blue/refs/heads/main/',
} as const

/** Member names — use these instead of hardcoding strings */
export const MEMBERS = {
  coreLib: 'core-lib',
  devTools: 'dev-tools',
  appPlatform: 'app-platform',
  dotfiles: 'dotfiles',
  homepage: 'homepage',
  studioOrg: 'studio-org',
  /** Nested members of dev-tools */
  cliFramework: 'cli-framework',
  uiKit: 'ui-kit',
  /** Nested members of app-platform */
  examples: 'examples',
} as const

/** GitHub source strings for members */
export const SOURCES = {
  coreLib: 'alice/core-lib',
  devTools: 'acme-org/dev-tools',
  appPlatform: 'acme-org/app-platform',
  dotfiles: 'alice/dotfiles',
  homepage: 'alice/homepage',
  studioOrg: 'acme-org/studio-org',
} as const

/** Megarepo members (those that contain nested members) */
export const MEGAREPO_MEMBERS = [MEMBERS.devTools, MEMBERS.appPlatform] as const

/** Standard member list for basic stories (6 members) */
export const STANDARD_MEMBERS = [
  MEMBERS.dotfiles,
  MEMBERS.homepage,
  MEMBERS.devTools,
  MEMBERS.appPlatform,
  MEMBERS.coreLib,
  MEMBERS.studioOrg,
] as const

/** Commit SHAs for story fixtures — shared across StatusOutput and SyncOutput */
export const COMMITS = {
  coreLib: { current: 'a1b2c3d4e5', previous: '9f8e7d6c5b' },
  devTools: { current: 'f0e1d2c3b4', previous: 'a5b6c7d8e9' },
  appPlatform: { current: '1a2b3c4d5e', previous: '9876543fed' },
  dotfiles: { current: 'abc1234def', previous: 'fedcba9876' },
  homepage: { current: 'deadbeef42', previous: 'cafebabe13' },
  studioOrg: { current: '7654321abc', previous: 'bbb2222ccc' },
} as const

/** Members that are pinned in the default story workspace */
export const PINNED_MEMBERS = [MEMBERS.coreLib] as const

/** Build command string from mode + flags, eliminating inline template duplication */
export const buildSyncCommand = ({
  mode,
  ...flags
}: {
  mode: string
  dryRun: boolean
  all: boolean
  verbose: boolean
  force: boolean
}) => {
  const parts = [`mr ${mode}`]
  if (flags.all === true) parts.push('--all')
  if (flags.dryRun === true) parts.push('--dry-run')
  if (flags.verbose === true) parts.push('--verbose')
  if (flags.force === true) parts.push('--force')
  return parts.join(' ')
}

/** Megarepo CLI flag argTypes for Storybook controls */
export const flagArgTypes = {
  dryRun: {
    description: '--dry-run: show what would happen without making changes',
    control: { type: 'boolean' },
  },
  all: {
    description: '--all: include nested megarepos recursively',
    control: { type: 'boolean' },
  },
  verbose: {
    description: '--verbose: show detailed information',
    control: { type: 'boolean' },
  },
  force: {
    description: '--force: include pinned members',
    control: { type: 'boolean' },
  },
} as const

/** Storybook select control for simulating the user's current working directory */
export const cwdArgType = {
  description: 'Simulated working directory (controls scope dimming)',
  control: { type: 'select' },
  options: [
    '(root)',
    MEMBERS.dotfiles,
    MEMBERS.homepage,
    MEMBERS.coreLib,
    MEMBERS.devTools,
    `${MEMBERS.devTools}/${MEMBERS.cliFramework}`,
    `${MEMBERS.devTools}/${MEMBERS.uiKit}`,
    MEMBERS.appPlatform,
    `${MEMBERS.appPlatform}/${MEMBERS.examples}`,
    MEMBERS.studioOrg,
  ],
} as const

/**
 * Parse a cwd arg value into `currentMemberPath` (for state) and `cwd` display string.
 *
 * `"(root)"` → `{ currentMemberPath: undefined, cwd: "~/workspace" }`
 * `"dev-tools"` → `{ currentMemberPath: ['dev-tools'], cwd: "~/workspace/dev-tools" }`
 */
export const parseCwdArg = ({
  value,
  workspaceName = 'workspace',
}: {
  value: string
  workspaceName?: string
}): { currentMemberPath: readonly string[] | undefined; cwd: string } => {
  if (value === '(root)') {
    return { currentMemberPath: undefined, cwd: `~/${workspaceName}` }
  }
  const segments = value.split('/')
  return { currentMemberPath: segments, cwd: `~/${workspaceName}/${value}` }
}

/** Apply cwd arg to a state object, only adding `currentMemberPath` when non-root. */
export const applyCwd = <S>({
  state,
  cwdArg,
  workspaceName,
}: {
  state: S
  cwdArg: string
  workspaceName?: string
}): { initialState: S; cwd: string } => {
  const { currentMemberPath, cwd } = parseCwdArg({
    value: cwdArg,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
  })
  if (currentMemberPath === undefined) return { initialState: state, cwd }
  return { initialState: { ...state, currentMemberPath } as S, cwd }
}
