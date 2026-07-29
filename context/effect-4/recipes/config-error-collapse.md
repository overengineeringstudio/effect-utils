# Pattern: config-error-collapse

**Area:** Config errors **Kind:** conditional

## Shape change

Effect 3 exposed `ConfigError` as a union of variants such as `MissingData`, `InvalidData`, `And`,
and `Or`. Effect 4 beta.102 exposes one `Config.ConfigError` class with `_tag: "ConfigError"`.

## Mapping

For sites that only carry or catch the error opaquely, replace the v3 module/type with
`Config.ConfigError`:

```ts
import { Config } from 'effect'

declare const layer: Layer.Layer<Service, Config.ConfigError>
```

## Mandatory stop condition

Before applying the import/type mapping, inspect every affected site. If a site discriminates a v3
variant, reads variant-specific fields, or selectively recovers one variant, **stop**. The variants
have collapsed and there is no faithful mechanical mapping.

## Verification

Checked against `effect@4.0.0-beta.102` `Config.ts`. In `@overeng/restate-effect`, all seven affected
sites were type-only or opaque and none discriminated a v3 variant, so the mapping was safe there.

## Gotchas

- A green typecheck after broadening handling to the single v4 tag can conceal changed recovery
  behavior. The site audit is required.
- Do not invent replacement tags for the removed variants.
