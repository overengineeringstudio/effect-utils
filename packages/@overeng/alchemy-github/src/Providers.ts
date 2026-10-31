import * as GitHub from '@alchemy.run/github'
import * as Provider from 'alchemy/Provider'
import { Layer } from 'effect'

import { ActionsSecret, ActionsSecretProvider } from './ActionsSecret.ts'
import { ActionsVariable, ActionsVariableProvider } from './ActionsVariable.ts'
import { App, AppProvider } from './App.ts'
import { SecretSourceLive } from './SecretSource.ts'

/** Resource additions to Alchemy's built-in GitHub provider collection. */
export class Providers extends Provider.ProviderCollection<Providers>()('GitHub.Additions') {}

/** Register App and Actions additions alongside upstream resources and authentication. */
export const providers = (
  options?: Parameters<typeof GitHub.providers>[0] & {
    readonly secretSource?: typeof SecretSourceLive
  },
) =>
  Layer.effect(Providers, Provider.collection([App, ActionsSecret, ActionsVariable])).pipe(
    Layer.provide(Layer.mergeAll(AppProvider, ActionsSecretProvider, ActionsVariableProvider)),
    Layer.provide(options?.secretSource ?? SecretSourceLive),
    Layer.provideMerge(GitHub.providers(options)),
  )
