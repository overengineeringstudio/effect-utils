import { dotdotConfig } from './packages/@overeng/genie/src/runtime/dotdot-config/mod.ts'

/** dotdot member config for the effect-utils workspace */
export default dotdotConfig({
  exposes: {
    '@overeng/dotdot': { path: 'packages/@overeng/dotdot' },
    '@overeng/genie': { path: 'packages/@overeng/genie' },
    '@overeng/mono': { path: 'packages/@overeng/mono' },
    '@overeng/utils': { path: 'packages/@overeng/utils' },
    '@overeng/notion-effect-schema': { path: 'packages/@overeng/notion-effect-schema' },
    '@overeng/notion-effect-client': { path: 'packages/@overeng/notion-effect-client' },
    '@overeng/notion-cli': { path: 'packages/@overeng/notion-cli' },
    '@overeng/effect-schema-form': { path: 'packages/@overeng/effect-schema-form' },
    '@overeng/effect-schema-form-aria': { path: 'packages/@overeng/effect-schema-form-aria' },
  },
  deps: {
    /** Effect repo for reference - helps agents write better Effect code */
    effect: {
      url: 'git@github.com:effect-ts/effect.git',
    },
    /** Centralized beads issue tracking with devenv module */
    'overeng-beads-public': {
      url: 'git@github.com:overengineeringstudio/overeng-beads-public.git',
    },
  },
})
