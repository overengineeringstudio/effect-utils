import { megarepoJson } from './packages/@overeng/genie/src/runtime/megarepo-config/mod.ts'

/** Megarepo config for effect-utils */
export default megarepoJson({
  members: {
    effect: 'effect-ts/effect',
    'overeng-beads-public': 'overengineeringstudio/overeng-beads-public',
  },
  generators: {
    nix: { enabled: true },
  },
})
