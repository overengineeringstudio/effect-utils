/**
 * Shared fixtures for DepsOutput stories.
 *
 * @internal
 */

import type { DepsState as DepsStateType, DepsMember } from '../mod.ts'

// =============================================================================
// Example Data
// =============================================================================

export const exampleDepsGraph: DepsMember[] = [
  {
    name: 'dev-tools',
    downstreamMembers: [
      { name: 'dotfiles', files: ['flake.nix', 'flake.lock'] },
      { name: 'app-platform', files: ['flake.nix'] },
      { name: 'studio-org', files: ['devenv.yaml', 'devenv.lock'] },
    ],
  },
  {
    name: 'app-platform',
    downstreamMembers: [{ name: 'dotfiles', files: ['flake.nix'] }],
  },
  {
    name: 'nixpkgs',
    downstreamMembers: [
      { name: 'dotfiles', files: ['flake.nix', 'flake.lock'] },
      { name: 'dev-tools', files: ['flake.nix', 'flake.lock'] },
      { name: 'app-platform', files: ['flake.nix', 'flake.lock'] },
      { name: 'studio-org', files: ['devenv.yaml', 'devenv.lock'] },
    ],
  },
]

export const singleUpstreamGraph: DepsMember[] = [
  {
    name: 'dev-tools',
    downstreamMembers: [
      { name: 'app-platform', files: ['flake.nix'] },
      { name: 'studio-org', files: ['devenv.yaml'] },
    ],
  },
]

// =============================================================================
// State Factories
// =============================================================================

export const createDepsSuccessState = (members?: DepsMember[]): DepsStateType => ({
  _tag: 'Success',
  members: members ?? exampleDepsGraph,
})

export const createDepsEmptyState = (): DepsStateType => ({
  _tag: 'Empty',
})

export const createDepsErrorState = (message?: string): DepsStateType => ({
  _tag: 'Error',
  message: message ?? 'Lock file required for mr deps — run `mr lock` first',
})
