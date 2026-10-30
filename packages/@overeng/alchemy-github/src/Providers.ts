import * as GitHub from '@alchemy.run/github'
import * as Provider from 'alchemy/Provider'
import { Layer } from 'effect'

import { App, AppProvider } from './App.ts'

/** App addition to Alchemy's built-in GitHub provider collection. */
export class Providers extends Provider.ProviderCollection<Providers>()('GitHub.Additions') {}

/** Register App alongside the upstream GitHub resources, including Ruleset, and auth. */
export const providers = (options?: Parameters<typeof GitHub.providers>[0]) =>
  Layer.effect(Providers, Provider.collection([App])).pipe(
    Layer.provide(AppProvider()),
    Layer.provideMerge(GitHub.providers(options)),
  )
