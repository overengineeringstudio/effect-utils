import {
  megarepoJson,
  type MegarepoConfigArgs,
} from './packages/@overeng/genie/src/runtime/megarepo-config/mod.ts'

export default megarepoJson({
  members: {
    /** Input members — consumed via lock files but never modified during alignment. */
    effect: 'effect-ts/effect',
    'overeng-beads-public': 'overengineeringstudio/overeng-beads-public',
  },
} satisfies MegarepoConfigArgs)
