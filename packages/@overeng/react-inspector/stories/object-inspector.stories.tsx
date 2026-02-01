import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Inspector } from '../src'

function namedFunction() {
  //
}

export default {
  title: 'Object Inspector',
  component: Inspector,
} satisfies Meta<typeof Inspector>

type Story = StoryObj<typeof Inspector>

/** Number: positive */
export const NumberPositive: Story = {
  render: () => <Inspector data={42} />,
}

/** Number: zero */
export const NumberZero: Story = {
  render: () => <Inspector data={0} />,
}

/** Number: negative */
export const NumberNegative: Story = {
  render: () => <Inspector data={-1} />,
}

/** Number: float */
export const NumberFloat: Story = {
  render: () => <Inspector data={1.5} />,
}

/** Number: exponential */
export const NumberExponential: Story = {
  render: () => <Inspector data={1e100} />,
}

/** Number: NaN */
export const NumberNaN: Story = {
  render: () => <Inspector data={NaN} />,
}

/** Number: Infinity */
export const NumberInfinity: Story = {
  render: () => <Inspector data={Infinity} />,
}

// BigInts

/** BigInt: positive */
export const BigIntPositive: Story = {
  render: () => <Inspector data={42n} />,
}

/** BigInt: zero */
export const BigIntZero: Story = {
  render: () => <Inspector data={0n} />,
}

/** BigInt: negative */
export const BigIntNegative: Story = {
  render: () => <Inspector data={-1n} />,
}

// Strings

/** String: empty string */
export const StringEmpty: Story = {
  render: () => <Inspector data="" />,
}

/** String: simple */
export const StringSimple: Story = {
  render: () => <Inspector data="hello" />,
}

// Booleans

/** Boolean: true */
export const BooleanTrue: Story = {
  render: () => <Inspector data={true} />,
}

/** Boolean: false */
export const BooleanFalse: Story = {
  render: () => <Inspector data={false} />,
}

// Undefined

export const UndefinedValue: Story = {
  name: 'Undefined',
  render: () => <Inspector data={undefined} />,
}

// Null

export const NullValue: Story = {
  name: 'Null',
  render: () => <Inspector data={null} />,
}

// Symbols

/** Symbol: test */
export const SymbolTest: Story = {
  render: () => <Inspector data={Symbol.for('test')} />,
}

// Arrays

/** Array: Empty Array */
export const ArrayEmpty: Story = {
  render: () => <Inspector data={[]} />,
}

/** Array: Empty Array (show non-enumerable properties) */
export const ArrayEmptyNonenumerable: Story = {
  render: () => <Inspector showNonenumerable data={[]} />,
}

/** Array: Basic Array */
export const ArrayBasic: Story = {
  render: () => <Inspector data={['cold', 'ice']} />,
}

/** Array: With different types of elements */
export const ArrayMixedTypes: Story = {
  render: () => <Inspector data={['a', 1, {}]} />,
}

/** Array: Long array */
export const ArrayLong: Story = {
  render: () => <Inspector data={Array.from({ length: 1000 }, (_, i) => i + '')} />,
}

/** Array: With big objects */
export const ArrayWithBigObjects: Story = {
  render: () => (
    <Inspector
      data={Array.from({ length: 100 }, (_, i) => ({
        key: i,
        name: `John #${i}`,
        dateOfBirth: new Date(i * 10e8),
        address: `${i} Main Street`,
        zip: 90210 + i,
      }))}
    />
  ),
}

/** Array: Uint32Array */
export const ArrayUint32Array: Story = {
  render: () => <Inspector data={new Uint32Array(1000)} />,
}

// Objects

/** Object: Date */
export const ObjectDate: Story = {
  render: () => <Inspector data={new Date('2005-04-03')} />,
}

/** Object: Regular Expression */
export const ObjectRegExp: Story = {
  render: () => <Inspector data={/^.*$/} />,
}

/** Object: Empty Object */
export const ObjectEmpty: Story = {
  render: () => <Inspector showNonenumerable expandLevel={1} data={{}} />,
}

/** Object: Empty String key */
export const ObjectEmptyStringKey: Story = {
  render: () => <Inspector data={{ '': 'hi' }} />,
}

/** Object: Object with getter property */
export const ObjectWithGetter: Story = {
  render: () => (
    <Inspector
      expandLevel={2}
      data={{
        get prop() {
          return 'v'
        },
      }}
    />
  ),
}

/** Object: Object with getter property that throws */
export const ObjectWithGetterThatThrows: Story = {
  render: () => (
    <Inspector
      expandLevel={2}
      data={{
        get prop(): never {
          throw new Error()
        },
      }}
    />
  ),
}

/** Object: Simple Object */
export const ObjectSimple: Story = {
  render: () => <Inspector showNonenumerable expandLevel={2} data={{ k: 'v' }} />,
}

/** Object: Simple inherited object */
export const ObjectSimpleInherited: Story = {
  render: () => <Inspector showNonenumerable expandLevel={2} data={Object.create({ k: 'v' })} />,
}

/** Object: `Object` */
export const ObjectConstructor: Story = {
  render: () => <Inspector showNonenumerable expandLevel={1} data={Object} />,
}

/** Object: `Object.prototype` */
export const ObjectPrototype: Story = {
  render: () => <Inspector showNonenumerable expandLevel={1} data={Object.prototype} />,
}

/** Object: Simple Object with name */
export const ObjectSimpleWithName: Story = {
  render: () => <Inspector showNonenumerable expandLevel={2} name="test" data={{ k: 'v' }} />,
}

/** Object: `Object.create(null)` (Empty object with null prototype) */
export const ObjectCreateNull: Story = {
  render: () => <Inspector showNonenumerable data={Object.create(null)} />,
}

/** Object: Object with null prototype */
export const ObjectWithNullPrototype: Story = {
  render: () => (
    <Inspector showNonenumerable data={Object.assign(Object.create(null), { key: 'value' })} />
  ),
}

// Maps

/** Map: Empty Map */
export const MapEmpty: Story = {
  render: () => <Inspector data={new Map()} />,
}

/** Map: Boolean keys */
export const MapBooleanKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map([
          [true, 'one'],
          [false, 'two'],
        ])
      }
    />
  ),
}

/** Map: Regex keys */
export const MapRegexKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map<RegExp, string>([
          [/\S/g, 'one'],
          [/\D/g, 'two'],
        ])
      }
    />
  ),
}

/** Map: String keys */
export const MapStringKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map([
          ['one', 1],
          ['two', 2],
        ])
      }
    />
  ),
}

/** Map: Object keys */
export const MapObjectKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map<object, number>([
          [{}, 1],
          [{ key: 2 }, 2],
        ])
      }
    />
  ),
}

/** Map: Array keys */
export const MapArrayKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map<number[], number>([
          [[1], 1],
          [[2], 2],
        ])
      }
    />
  ),
}

/** Map: Map keys */
export const MapMapKeys: Story = {
  render: () => (
    <Inspector
      data={
        new Map<Map<unknown, unknown>, number>([
          [new Map(), 1],
          [new Map([]), 2],
        ])
      }
    />
  ),
}

// Sets

/** Set: Empty Set */
export const SetEmpty: Story = {
  render: () => <Inspector data={new Set()} />,
}

/** Set: Simple Set */
export const SetSimple: Story = {
  render: () => <Inspector data={new Set([1, 2, 3, 4])} />,
}

/** Set: Nested Set */
export const SetNested: Story = {
  render: () => <Inspector data={new Set([1, 2, 3, new Set([1, 2])])} />,
}

// Functions

/** Functions: anonymous function */
export const FunctionAnonymous: Story = {
  render: () => <Inspector data={function () {}} />,
}

/** Functions: anonymous arrow function */
export const FunctionArrow: Story = {
  render: () => <Inspector data={() => {}} />,
}

/** Functions: named function */
export const FunctionNamed: Story = {
  render: () => <Inspector data={namedFunction} />,
}

/** Functions: named function (show non-enumerable properties) */
export const FunctionNamedNonenumerable: Story = {
  render: () => <Inspector showNonenumerable data={namedFunction} />,
}

// Nested object examples

/** Nested: Ice sculpture */
export const NestedIceSculpture: Story = {
  render: () => (
    <Inspector
      expandLevel={2}
      data={{
        id: 2,
        name: 'An ice sculpture',
        tags: ['cold', 'ice'],
        dimensions: {
          length: 7.0,
          width: 12.0,
          height: 9.5,
        },
        warehouseLocation: {
          latitude: -78.75,
          longitude: 20.4,
        },
      }}
    />
  ),
}

/** Nested: Github */
export const NestedGithub: Story = {
  render: () => (
    <Inspector
      expandLevel={1}
      data={{
        login: 'defunkt',
        id: 2,
        avatar_url: 'https://avatars.githubusercontent.com/u/2?v=3',
        gravatar_id: '',
        url: 'https://api.github.com/users/defunkt',
        html_url: 'https://github.com/defunkt',
        followers_url: 'https://api.github.com/users/defunkt/followers',
        following_url: 'https://api.github.com/users/defunkt/following{/other_user}',
        gists_url: 'https://api.github.com/users/defunkt/gists{/gist_id}',
        starred_url: 'https://api.github.com/users/defunkt/starred{/owner}{/repo}',
        subscriptions_url: 'https://api.github.com/users/defunkt/subscriptions',
        organizations_url: 'https://api.github.com/users/defunkt/orgs',
        repos_url: 'https://api.github.com/users/defunkt/repos',
        events_url: 'https://api.github.com/users/defunkt/events{/privacy}',
        received_events_url: 'https://api.github.com/users/defunkt/received_events',
        type: 'User',
        site_admin: true,
        name: 'Chris Wanstrath',
        company: 'GitHub',
        blog: 'http://chriswanstrath.com/',
        location: 'San Francisco',
        email: 'chris@github.com',
        hireable: true,
        bio: null,
        public_repos: 108,
        public_gists: 280,
        followers: 14509,
        following: 208,
        created_at: '2007-10-20T05:24:19Z',
        updated_at: '2015-08-03T18:05:52Z',
      }}
    />
  ),
}

/** Nested: Glossary */
export const NestedGlossary: Story = {
  render: () => (
    <Inspector
      expandLevel={7}
      data={{
        glossary: {
          title: 'example glossary',
          GlossDiv: {
            title: 'S',
            GlossList: {
              GlossEntry: {
                ID: 'SGML',
                SortAs: 'SGML',
                GlossTerm: 'Standard Generalized Markup Language',
                Acronym: 'SGML',
                Abbrev: 'ISO 8879:1986',
                GlossDef: {
                  para: 'A meta-markup language, used to create markup languages such as DocBook.',
                  GlossSeeAlso: ['GML', 'XML'],
                },
                GlossSee: 'markup',
              },
            },
          },
        },
      }}
    />
  ),
}

/** Nested: Contrived example */
export const NestedContrived: Story = {
  render: () => (
    <Inspector
      expandLevel={3}
      data={{
        a1: 1,
        a2: 'A2',
        a3: true,
        a4: undefined,
        a5: {
          'a5-1': null,
          'a5-2': ['a5-2-1', 'a5-2-2'],
          'a5-3': {},
        },
        a6: function () {
          console.log('hello world')
        },
        a7: new Date('2005-04-03'),
      }}
    />
  ),
}
