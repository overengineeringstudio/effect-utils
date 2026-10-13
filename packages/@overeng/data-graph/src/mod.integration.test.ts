import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'

import { scenario } from './scenario.ts'

it.effect(
  'demonstrates both cutoffs, output channels, freshness and rejected observations with real CAS',
  () => scenario().pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
