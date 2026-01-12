import { dotdotConfig } from './packages/@overeng/genie/src/runtime/dotdot-config/mod.ts'

/** dotdot config for the effect-utils workspace itself */
export default dotdotConfig({
  repos: {
    'effect-utils': {
      url: 'git@github.com:overengineeringstudio/effect-utils.git',
      install: 'bun install --frozen-lockfile',
      packages: {
        '@overeng/dotdot': { path: 'packages/@overeng/dotdot' },
        '@overeng/genie': { path: 'packages/@overeng/genie' },
        '@overeng/mono': { path: 'packages/@overeng/mono' },
        '@overeng/utils': { path: 'packages/@overeng/utils' },
        '@overeng/bun-compose': { path: 'packages/@overeng/bun-compose' },
        '@overeng/pnpm-compose': { path: 'packages/@overeng/pnpm-compose' },
        '@overeng/notion-effect-schema': { path: 'packages/@overeng/notion-effect-schema' },
        '@overeng/notion-effect-client': { path: 'packages/@overeng/notion-effect-client' },
        '@overeng/notion-cli': { path: 'packages/@overeng/notion-cli' },
        '@overeng/effect-schema-form': { path: 'packages/@overeng/effect-schema-form' },
        '@overeng/effect-schema-form-aria': { path: 'packages/@overeng/effect-schema-form-aria' },
      },
    },
    /** For reference only to help agents write better Effect code */
    effect: {
      url: 'git@github.com:effect-ts/effect.git',
      rev: 'c9dc711464561227b8470edaa6052056ede41289',
    },
  },
})
