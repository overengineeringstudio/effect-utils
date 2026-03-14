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
    name: 'effect-utils',
    downstreamMembers: [
      { name: 'dotfiles', files: ['flake.nix', 'flake.lock'] },
      { name: 'livestore', files: ['flake.nix'] },
      { name: 'overeng', files: ['devenv.yaml', 'devenv.lock'] },
    ],
  },
  {
    name: 'livestore',
    downstreamMembers: [
      { name: 'dotfiles', files: ['flake.nix'] },
    ],
  },
  {
    name: 'nixpkgs',
    downstreamMembers: [
      { name: 'dotfiles', files: ['flake.nix', 'flake.lock'] },
      { name: 'effect-utils', files: ['flake.nix', 'flake.lock'] },
      { name: 'livestore', files: ['flake.nix', 'flake.lock'] },
      { name: 'overeng', files: ['devenv.yaml', 'devenv.lock'] },
    ],
  },
]

export const singleUpstreamGraph: DepsMember[] = [
  {
    name: 'effect-utils',
    downstreamMembers: [
      { name: 'livestore', files: ['flake.nix'] },
      { name: 'overeng', files: ['devenv.yaml'] },
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
