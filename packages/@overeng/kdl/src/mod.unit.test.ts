import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  clearFormat,
  Document,
  format,
  KdlParseError,
  Node,
  parse,
  parseEffect,
  stringifyString,
} from './mod.ts'

describe('kdl baselines (cross-major invariant)', () => {
  it('round-trips representative source bytes without normalizing formatting', () => {
    const source = `// leading
(service)server "Ada 世界" port = 8_080 enabled=#false /- ignored=1 {
    path #"C:\\tmp"# // raw
    nested (unit)1.0E+3
}
`

    expect(format(parse(source))).toBe(source)
  })

  it('normalizes encoded bytes with current property, child, and number-format rules', () => {
    const document = parse(`root 1 z=1 a=2 z=3 {
  empty {}
  child "two words" int=1 float=1.0 exponent=1e2 floatExponent=1.0e2
}
`)

    expect(format(clearFormat(document))).toMatchInlineSnapshot(`
      "root 1 a=2 z=3 {
          empty
          child "two words" exponent=1E+2 float=1.0 floatExponent=1.0E+2 int=1
      }
      "
    `)
  })

  it('encodes programmatically constructed AST values byte-identically', () => {
    const root = Node.create('needs space')
    root.setTag('root tag')
    root.addArgument('Ada 世界')
    root.addArgument(Number.NaN, 'not-a-number')
    root.setProperty('enabled', false)
    root.setProperty('positive', Number.POSITIVE_INFINITY)
    root.setProperty('negative', Number.NEGATIVE_INFINITY)
    root.appendNode(Node.create('child'))

    expect(format(new Document([root]))).toMatchInlineSnapshot(`
      "("root tag")"needs space" "Ada 世界" (not-a-number)#nan enabled=#false positive=#inf negative=#-inf {
          child
      }
      "
    `)
  })

  it('preserves duplicate-property lookup, mutation, and clear-format collapse behavior', () => {
    const node = parse('item z=1 a=2 z=3', { as: 'node' })
    const before = {
      properties: [...node.getProperties()],
      z: node.getProperty('z'),
      bytes: format(node),
    }

    node.setProperty('z', 4, 'count')
    node.addArgument('tail', null, 0)
    const mutated = format(node)
    const normalized = format(clearFormat(node))

    expect(JSON.stringify({ before, mutated, normalized })).toMatchInlineSnapshot(
      `"{"before":{"properties":[["z",3],["a",2]],"z":3,"bytes":"item z=1 a=2 z=3\\n"},"mutated":"item z=1 a=2 z=(count)4 tail\\n","normalized":"item tail a=2 z=(count)4\\n"}"`,
    )
  })

  it('keeps public parse targets and string escaping in their current byte partitions', () => {
    const values = {
      value: format(parse('1.0', { as: 'value' })),
      identifier: format(parse('"two words"', { as: 'identifier' })),
      argument: format(parse('(kind)"hello"', { as: 'entry' })),
      property: format(parse('answer = (unit) 42', { as: 'entry' })),
      node: format(parse('(tag) node 1 key=#null', { as: 'node' })),
      strings: ['', 'bare', 'true', '1start', 'two words', 'quote"slash\\', 'line\n世界'].map(
        (value) => stringifyString(value),
      ),
    }

    expect(JSON.stringify(values)).toMatchInlineSnapshot(
      `"{"value":"1.0","identifier":"\\"two words\\"","argument":" (kind)\\"hello\\"","property":" answer = (unit) 42","node":"(tag) node 1 key=#null\\n","strings":["\\"\\"","bare","\\"true\\"","\\"1start\\"","\\"two words\\"","\\"quote\\\\\\"slash\\\\\\\\\\"","\\"line\\\\n世界\\""]}"`,
    )
  })

  it('maps parser failures into the current Effect error shape and location bytes', async () => {
    const error = await Effect.runPromise(Effect.flip(parseEffect('node key=\n')))

    expect(error).toBeInstanceOf(KdlParseError)
    expect(
      JSON.stringify({
        tag: error._tag,
        message: error.message,
        start: Option.getOrNull(error.start),
        end: Option.getOrNull(error.end),
        flat: Array.from(error.flat(), (item) => item.message),
      }),
    ).toMatchInlineSnapshot(
      `"{"tag":"KdlParseError","message":"Expected a value at 1:10","start":{"offset":9,"line":1,"column":10},"end":{"offset":10,"line":2,"column":1},"flat":["Expected a value at 1:10"]}"`,
    )
  })

  it('keeps programmer/input failures outside the typed Effect failure partition', () => {
    expect(() => parse('node', { as: 'missing' as never })).toThrow(
      'Invalid "as" target passed: "missing"',
    )
    expect(() => parse(new Uint8Array([0xff]))).toThrow()
    expect(() => format({ type: 'other' } as never)).toThrow(
      'Cannot format non-KDL [object Object]',
    )
    expect(() => clearFormat({ type: 'other' } as never)).toThrow(
      'Cannot clear formatting on non-KDL [object Object]',
    )
  })
})
