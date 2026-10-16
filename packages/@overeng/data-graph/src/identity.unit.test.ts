import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import { descriptorForUtf8 } from '@overeng/content-address'

import { actionKey, NodeKind } from './mod.ts'

const kind = Schema.decodeSync(NodeKind)('property-source')
const recipe = { kind, version: '1', config: {} }

it.prop(
  'action identity is deterministic and input permutation invariant',
  [Schema.String, Schema.String],
  ([left, right]) => {
    const a = descriptorForUtf8({ value: left })
    const b = descriptorForUtf8({ value: right })
    const first = Object.fromEntries([
      ['constructor', a],
      ['__proto__', b],
    ])
    const second = Object.fromEntries([
      ['__proto__', b],
      ['constructor', a],
    ])
    expect(actionKey({ recipe, inputs: first })).toBe(actionKey({ recipe, inputs: first }))
    expect(actionKey({ recipe, inputs: first })).toBe(actionKey({ recipe, inputs: second }))
  },
)

it.prop(
  'recipe version, config and any descriptor change action identity',
  [Schema.String],
  ([value]) => {
    const inputs = { value: descriptorForUtf8({ value }) }
    const key = actionKey({ recipe, inputs })
    expect(actionKey({ recipe: { ...recipe, version: '2' }, inputs })).not.toBe(key)
    expect(actionKey({ recipe: { ...recipe, config: { value } }, inputs })).not.toBe(key)
    expect(
      actionKey({ recipe, inputs: { value: descriptorForUtf8({ value: `${value}\0` }) } }),
    ).not.toBe(key)
    expect(
      actionKey({
        recipe,
        inputs: { value: descriptorForUtf8({ value, mediaType: 'application/octet-stream' }) },
      }),
    ).not.toBe(key)
  },
)
