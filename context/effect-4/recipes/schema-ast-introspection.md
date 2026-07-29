# Pattern: SchemaAST introspection

**Area:** Schema AST tooling **Kind:** representation and shape change **Our usage:** schema-driven
form metadata, tagged-struct detection, property enumeration, and other direct AST consumers.

## Shape changes first

Effect 4 does not rename the Effect 3 wrapper nodes one-for-one. The decoded node is the AST root:

- refinements are `ast.checks`;
- transformations are `ast.encoding`;
- each encoding `Link.to` is the encoded side, not the decoded replacement;
- `SchemaAST.toType(ast)` strips encodings and returns the decoded view.

Do not migrate `Transformation.to` by traversing `Link.to`; that reverses the question and inspects
the wire representation.

## Node and property mappings

| Effect 3 | Effect 4 |
| --- | --- |
| `StringKeyword` | `String` |
| `NumberKeyword` | `Number` |
| `BooleanKeyword` | `Boolean` |
| `UndefinedKeyword` | `Undefined` |
| `TupleType` | `Arrays` |
| `TypeLiteral` | `Objects` |
| `Enums` | `Enum` |
| `Refinement.from` | no node traversal; checks are attached to the decoded node |
| `Transformation.to` | `SchemaAST.toType(ast)` |
| `PropertySignature.isOptional` | `SchemaAST.isOptional(property.type)` |
| `PropertySignature.annotations` | `property.type.context?.annotations` |

`Objects.propertySignatures` retains declaration order and each property remains a `{ name, type }`
pair.

## Optional values versus optional keys

V4 key optionality lives in `ast.context?.isOptional` and is exposed by
`SchemaAST.isOptional(ast)`. That alone is not a faithful replacement for an introspector that also
classified `Schema.UndefinedOr(S)` as optional.

For that behavior, additionally recognize an exact two-member `Union` containing one `Undefined`
member and return the other member as the inner schema. Do not classify wider unions this way.

## Annotations

Value-level annotation IDs became string-keyed resolvers:

```ts
SchemaAST.resolveTitle(ast)
SchemaAST.resolveDescription(ast)
```

Repository-owned symbol annotations remain present in the resolved annotation object, but the
public type exposes only string keys. Read a unique-symbol key through a narrow helper:

```ts
const resolveAnnotation = <T>(ast: SchemaAST.AST, key: symbol): T | undefined =>
  (SchemaAST.resolve(ast) as unknown as Record<PropertyKey, unknown> | undefined)?.[key] as
    | T
    | undefined
```

Key/property annotations live at `property.type.context?.annotations` and take precedence over
value annotations when both exist.

Effect 4 no longer supplies all implicit primitive metadata that Effect 3 exposed. For example,
`Schema.Int` retains `expected: "an integer"` on its final check but does not expose the former
implicit `title: "int"` and `description: "an integer"` pair. Do not invent fallback titles or
silently update UI baselines; measure the owning package's label impact and record an explicit
decision.

## Any schema without services

`Schema.Top` is too wide as a replacement for `Schema.Schema.AnyNoContext`: its decoding and
encoding service slots are `unknown`, so it admits serviceful codecs.

Use the service-free bound:

```ts
type AnyNoContext = Schema.Codec<unknown, unknown, never, never>
```

## Equivalence

The mappings above were checked against the `effect@4.0.0-beta.102` declarations and runtime ASTs
for annotated primitives, checks, encodings, `UndefinedOr`, `optional`, `optionalKey`, literal
unions, structs, tuples, and `NumberFromString`.

Owning slices must compare the questions their introspector answers: decoded field classification,
property order, optional-key and undefined-value handling, literal order, tagged detection,
resolved metadata, and any exposed raw AST representation.

## Gotchas

- `Link.to` is the encoded side.
- Checks do not introduce a wrapper node, so a checked number still has `_tag: "Number"`.
- `SchemaAST.isOptional` detects key optionality, not every union that accepts `undefined`.
- `SchemaAST.resolveTitle` and `resolveDescription` read value/check annotations, not key context.
- Indexing the public result of `SchemaAST.resolve` with a unique symbol requires the narrow
  `Record<PropertyKey, unknown>` cast above; do not widen the rest of the AST consumer.
- Raw `_tag` values and implicit primitive metadata differ even when field classification is
  preserved.

## Codemod rule

Only the direct tag and resolver renames are mechanical. Transformation direction, optionality,
key-annotation precedence, service bounds, and user-visible metadata require runtime verification.
