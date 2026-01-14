import { nixCommand as createNixCommand } from '@overeng/mono'

const nixPackages = [
  {
    name: 'genie',
    flakeRef: '.#genie',
    flakeDir: '.',
    buildNixPath: 'packages/@overeng/genie/nix/build.nix',
  },
  {
    name: 'dotdot',
    flakeRef: '.#dotdot',
    flakeDir: '.',
    buildNixPath: 'packages/@overeng/dotdot/nix/build.nix',
  },
  {
    name: 'mono',
    flakeRef: '.#mono',
    flakeDir: '.',
    noWriteLock: true,
    binaryName: 'mono',
    buildNixPath: 'scripts/nix/build.nix',
  },
] as const

/** Nix command for managing workspace Nix packages */
export const nixCommand = createNixCommand({ packages: nixPackages })
