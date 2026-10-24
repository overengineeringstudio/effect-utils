import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { materializationRecipeKey, parseMaterializationRecipe } from './materialization-recipes.ts'

const recipe = [
  'effect-utils/buck-materialization-recipe/v1',
  'a'.repeat(64),
  'b'.repeat(64),
  'package',
  ['c'.repeat(64), 'd'.repeat(64)],
]
describe('native recipe wire identity', () => {
  it('hashes the exact compact ordered JSON array as UTF8', () => {
    const parsed = parseMaterializationRecipe(recipe)
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(recipe))
    expect(materializationRecipeKey(parsed)).toBe(
      createHash('sha256').update(JSON.stringify(recipe)).digest('hex'),
    )
    expect(
      materializationRecipeKey(
        parseMaterializationRecipe([...recipe.slice(0, 4), ['d'.repeat(64), 'c'.repeat(64)]]),
      ),
    ).not.toBe(materializationRecipeKey(parsed))
  })
  it('rejects unknown versions, malformed digests, unsafe prefixes and extra fields', () => {
    for (const value of [
      [],
      [...recipe, true],
      ['v2', ...recipe.slice(1)],
      [recipe[0], 'A'.repeat(64), ...recipe.slice(2)],
      [...recipe.slice(0, 3), '../package', []],
      [...recipe.slice(0, 3), 'a\\b', []],
      [...recipe.slice(0, 3), 'a\u0000b', []],
    ])
      expect(() => parseMaterializationRecipe(value)).toThrow('invalid recipe')
  })
})
