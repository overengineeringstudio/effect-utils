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
export const storePath = (source: string, ref: string) =>
  `${STORE_BASE}/github.com/${source}/refs/heads/${ref}/` as const

/** Default workspace used in most stories */
export const WORKSPACE = {
  name: 'dev-workspace',
  root: storePath('alice/dev-workspace', 'main'),
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
