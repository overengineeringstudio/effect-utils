import { Schema } from 'effect'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  analyzeSchema,
  analyzeTaggedStruct,
  formatLiteralLabel,
  getStructProperties,
  SchemaForm,
  SchemaFormProvider,
  useFieldMeta,
  useSchemaForm,
  useSchemaFormContext,
} from './mod.ts'
import type { FieldMeta, PropertyInfo } from './types.ts'

const metaBytes = (meta: FieldMeta): string =>
  JSON.stringify({
    type: meta.type,
    title: meta.title,
    description: meta.description,
    literals: meta.literals,
    isOptional: meta.isOptional,
    innerAstTag: meta.innerSchema.ast._tag,
  })

const propertyBytes = (properties: readonly PropertyInfo[]): string =>
  JSON.stringify(
    properties.map(({ key, meta }) => ({
      key,
      meta: JSON.parse(metaBytes(meta)),
    })),
  )

describe('effect-schema-form baselines (cross-major invariant)', () => {
  const Contact = Schema.TaggedStruct('Contact', {
    name: Schema.String.annotations({
      title: 'Display name',
      description: 'Shown to other people',
    }),
    age: Schema.optional(Schema.Int.annotations({ title: 'Age' })),
    role: Schema.Literal('admin', 'guest'),
    active: Schema.Boolean,
    unsupported: Schema.Tuple(Schema.String),
  })

  const value: typeof Contact.Type = {
    _tag: 'Contact',
    name: 'Ada <世界>',
    role: 'guest',
    active: false,
    unsupported: [''],
  }

  it('encodes schema introspection metadata with the current optional and unknown partitions', () => {
    const cases = {
      annotatedString: analyzeSchema(
        Schema.String.annotations({ title: 'Title', description: 'Description' }),
      ),
      optionalInt: analyzeSchema(Schema.UndefinedOr(Schema.Int)),
      literalUnion: analyzeSchema(Schema.Literal('', 'kebab-case', '東京')),
      struct: analyzeSchema(Schema.Struct({ value: Schema.String })),
      tuple: analyzeSchema(Schema.Tuple(Schema.String)),
      unknown: analyzeSchema(Schema.Unknown),
    }

    expect(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(cases).map(([key, meta]) => [key, JSON.parse(metaBytes(meta))]),
        ),
      ),
    ).toMatchInlineSnapshot(
      `"{"annotatedString":{"type":"string","title":"Title","description":"Description","isOptional":false,"innerAstTag":"StringKeyword"},"optionalInt":{"type":"number","title":"int","description":"an integer","isOptional":true,"innerAstTag":"Refinement"},"literalUnion":{"type":"literal","literals":["","kebab-case","東京"],"isOptional":false,"innerAstTag":"Union"},"struct":{"type":"struct","isOptional":false,"innerAstTag":"TypeLiteral"},"tuple":{"type":"unknown","isOptional":false,"innerAstTag":"TupleType"},"unknown":{"type":"unknown","title":"unknown","isOptional":false,"innerAstTag":"UnknownKeyword"}}"`,
    )
  })

  it('encodes struct and tagged-struct property discovery in declaration order', () => {
    const properties = getStructProperties(Contact)
    const tagged = analyzeTaggedStruct(Contact)

    expect(
      JSON.stringify({
        properties: JSON.parse(propertyBytes(properties)),
        tagged: {
          isTagged: tagged.isTagged,
          tagValue: tagged.tagValue,
          contentKeys: tagged.contentProperties.map(({ key }) => key),
        },
        nonStructProperties: getStructProperties(Schema.String).length,
        nonTagged: analyzeTaggedStruct(Schema.Struct({ value: Schema.String })).isTagged,
      }),
    ).toMatchInlineSnapshot(
      `"{"properties":[{"key":"_tag","meta":{"type":"literal","literals":["Contact"],"isOptional":false,"innerAstTag":"Literal"}},{"key":"name","meta":{"type":"string","title":"Display name","description":"Shown to other people","isOptional":false,"innerAstTag":"StringKeyword"}},{"key":"age","meta":{"type":"number","title":"Age","description":"an integer","isOptional":true,"innerAstTag":"Refinement"}},{"key":"role","meta":{"type":"literal","literals":["admin","guest"],"isOptional":false,"innerAstTag":"Union"}},{"key":"active","meta":{"type":"boolean","title":"boolean","description":"a boolean","isOptional":false,"innerAstTag":"BooleanKeyword"}},{"key":"unsupported","meta":{"type":"unknown","isOptional":false,"innerAstTag":"TupleType"}}],"tagged":{"isTagged":true,"tagValue":"Contact","contentKeys":["name","age","role","active","unsupported"]},"nonStructProperties":0,"nonTagged":false}"`,
    )
  })

  it('renders byte-identical markup with tag filtering, prop precedence, and unknown fallback', () => {
    const html = renderToStaticMarkup(
      <SchemaFormProvider
        renderers={{
          string: ({ fieldKey, value: fieldValue, meta }) => (
            <label data-source="context" data-key={fieldKey} title={meta.description}>
              {meta.title}:{String(fieldValue)}
            </label>
          ),
          number: ({ fieldKey, value: fieldValue }) => (
            <output data-key={fieldKey}>{String(fieldValue)}</output>
          ),
          literal: ({ fieldKey, value: fieldValue }) => (
            <output data-key={fieldKey}>{String(fieldValue)}</output>
          ),
          boolean: ({ fieldKey, value: fieldValue }) => (
            <output data-key={fieldKey}>{String(fieldValue)}</output>
          ),
          unknown: ({ fieldKey, value: fieldValue }) => (
            <pre data-key={fieldKey}>{JSON.stringify(fieldValue)}</pre>
          ),
        }}
      >
        <SchemaForm
          schema={Contact}
          value={value}
          onChange={vi.fn()}
          renderers={{
            string: ({ fieldKey, value: fieldValue }) => (
              <input data-source="prop" data-key={fieldKey} value={String(fieldValue)} readOnly />
            ),
          }}
          wrapper={({ children, tagInfo }) => (
            <section data-tag={tagInfo.tagValue}>{children}</section>
          )}
        />
      </SchemaFormProvider>,
    )

    expect(html).toMatchInlineSnapshot(
      `"<section data-tag="Contact"><div><input data-source="prop" data-key="name" readOnly="" value="Ada &lt;世界&gt;"/></div><div><output data-key="age">undefined</output></div><div><output data-key="role">guest</output></div><div><output data-key="active">false</output></div><div><pre data-key="unsupported">[&quot;&quot;]</pre></div></section>"`,
    )
  })

  it('renders the current empty output for unsupported roots and missing renderers', () => {
    const unsupportedRoot = renderToStaticMarkup(
      <SchemaForm
        schema={Schema.String as unknown as Schema.Schema<Record<string, unknown>>}
        value={{}}
        onChange={vi.fn()}
      />,
    )
    const missingRenderer = renderToStaticMarkup(
      <SchemaForm
        schema={Schema.Struct({ value: Schema.String })}
        value={{ value: 'unrendered' }}
        onChange={vi.fn()}
      />,
    )

    expect(JSON.stringify({ unsupportedRoot, missingRenderer })).toMatchInlineSnapshot(
      `"{"unsupportedRoot":"","missingRenderer":"<div></div>"}"`,
    )
  })

  it('encodes hook metadata, context, reads, and shallow change payloads through SSR', () => {
    const changes: unknown[] = []

    const Probe = (): ReactNode => {
      const context = useSchemaFormContext()
      const fieldMeta = useFieldMeta(Schema.UndefinedOr(Schema.Number)).meta
      const form = useSchemaForm({
        schema: Schema.Struct({
          name: Schema.String,
          note: Schema.optional(Schema.String),
        }),
        value: { name: 'before', note: '' },
        onChange: (next) => changes.push(next),
      })
      form.setValue('name', 'after')
      form.setValues({ note: '東京' })

      return (
        <output>
          {JSON.stringify({
            hasStringRenderer: context?.renderers.string !== undefined,
            fieldMeta: JSON.parse(metaBytes(fieldMeta)),
            keys: form.fields.map(({ key }) => key),
            name: form.getValue('name'),
            tagged: form.tagInfo.isTagged,
          })}
        </output>
      )
    }

    const html = renderToStaticMarkup(
      <SchemaFormProvider renderers={{ string: () => null }}>
        <Probe />
      </SchemaFormProvider>,
    )

    expect(JSON.stringify({ html, changes })).toMatchInlineSnapshot(
      `"{"html":"<output>{&quot;hasStringRenderer&quot;:true,&quot;fieldMeta&quot;:{&quot;type&quot;:&quot;number&quot;,&quot;title&quot;:&quot;number&quot;,&quot;description&quot;:&quot;a number&quot;,&quot;isOptional&quot;:true,&quot;innerAstTag&quot;:&quot;NumberKeyword&quot;},&quot;keys&quot;:[&quot;name&quot;,&quot;note&quot;],&quot;name&quot;:&quot;before&quot;,&quot;tagged&quot;:false}</output>","changes":[{"name":"after","note":""},{"name":"before","note":"東京"}]}"`,
    )
  })

  it('keeps renderer exceptions in the synchronous defect partition', () => {
    expect(() =>
      renderToStaticMarkup(
        <SchemaForm
          schema={Schema.Struct({ value: Schema.String })}
          value={{ value: 'boom' }}
          onChange={vi.fn()}
          renderers={{
            string: () => {
              throw new Error('renderer boom')
            },
          }}
        />,
      ),
    ).toThrow('renderer boom')
  })

  it('formats representative and awkward literal labels byte-identically', () => {
    expect(
      JSON.stringify(
        ['', 'my-option', 'someValue', 'snake_case', 'two--gaps', 'UPPER', '東京_value'].map(
          (input) => [input, formatLiteralLabel(input)],
        ),
      ),
    ).toMatchInlineSnapshot(
      `"[["",""],["my-option","My Option"],["someValue","Some Value"],["snake_case","Snake Case"],["two--gaps","Two  Gaps"],["UPPER","Upper"],["東京_value","東京 Value"]]"`,
    )
  })
})
