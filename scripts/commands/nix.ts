/** Nix packages managed in this workspace */
export const nixPackages = [
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
