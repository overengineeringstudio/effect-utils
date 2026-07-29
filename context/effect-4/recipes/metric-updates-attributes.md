# Pattern: metric-updates-attributes

**Area:** Metrics / telemetry **Kind:** shape change **Our usage:** about 29 affected references,
including the schema-backed instruments in `otel-contract`, resource gauges in `utils`, and
telemetry tests.

## Shape changes first

- A v4 `Metric` is no longer a callable effect. Mutations go through `Metric.update`.
- `MetricLabel` is removed. V4 metrics use string attributes supplied as a record or
  `ReadonlyArray<[string, string]>`.
- Attribute names must be unique for a faithful port. V3 could retain two `MetricLabel`s with the
  same key; v4 attributes collapse them to one key.
- Snapshot entries changed from `{ metricKey, metricState }` to
  `{ id, type, state, attributes }`.

All mappings and observations below are **VERIFIED** against the real
`effect@4.0.0-beta.102` tarball (SHA-1
`f51092854960f60cbdb06bd59e788acbc8ee8492`).

## v3

```ts
import { Metric, MetricLabel } from 'effect'

const labels = [MetricLabel.make('route', 'alpha'), MetricLabel.make('method', 'GET')]

const counter = Metric.counter('requests').pipe(Metric.taggedWithLabels(labels))
const gauge = Metric.gauge('queue_depth')

yield * Metric.increment(counter)
yield * Metric.incrementBy(counter, 2)
yield * Metric.set(gauge, 42)
```

## v4

```ts
import { Metric } from 'effect'

const attributes: Metric.Metric.Attributes = [
  ['route', 'alpha'],
  ['method', 'GET'],
]

const counter = Metric.counter('requests').pipe(Metric.withAttributes(attributes))
const gauge = Metric.gauge('queue_depth')

yield * Metric.update(counter, 1)
yield * Metric.update(counter, 2)
yield * Metric.update(gauge, 42)
```

## Migration table

| v3                                        | v4                                                                       | Shape                          |
| ----------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `Metric.increment(metric)`                | `Metric.update(metric, 1)`                                               | named mutation to input        |
| `Metric.incrementBy(metric, amount)`      | `Metric.update(metric, amount)`                                          | named mutation to input        |
| `Metric.set(gauge, value)`                | `Metric.update(gauge, value)`                                            | named mutation to input        |
| `Metric.tagged(metric, key, value)`       | `Metric.withAttributes(metric, [[key, value]])`                          | label to attribute             |
| `Metric.taggedWithLabels(metric, labels)` | `Metric.withAttributes(metric, attributes)`                              | label objects to attribute set |
| `MetricLabel.make(key, value)`            | `[key, value] as const`                                                  | object to tuple                |
| `ReadonlyArray<MetricLabel.MetricLabel>`  | `Metric.Metric.Attributes` or `ReadonlyArray<readonly [string, string]>` | nominal objects to strings     |
| `pair.metricKey.name`                     | `snapshot.id`                                                            | snapshot shape                 |
| `pair.metricKey.tags`                     | `snapshot.attributes`                                                    | array to record                |
| `pair.metricState`                        | `snapshot.state`                                                         | field rename                   |

Use the tuple form when keys are computed. A record is convenient for known static keys:

```ts
Metric.withAttributes(metric, { route: 'alpha', method: 'GET' })
```

## Equivalence

A direct cross-major probe used the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. After normalizing the snapshot shapes:

- v3 `increment` followed by `incrementBy(2)` and v4 `update(1)` followed by `update(2)` both
  produced counter value `3`;
- a second label set produced a separate counter series with value `1` in both majors;
- v3 `set(41)` followed by `increment` and v4 `update(41)` followed by `update(42)` both produced
  gauge value `42`;
- both snapshots contained exactly three series with the same unique-key label/attribute sets and
  values.

This verifies the replacement for the repository's ordinary unique-key telemetry. Each owning
slice must still compare exported instrument name, kind, description, unit, attribute set, value,
and series cardinality through its real telemetry exporter.

## Duplicate-key trap

The same probe deliberately composed two values for one key:

```ts
// v3 snapshot labels: [["key", "a"], ["key", "b"]]
metric.pipe(Metric.tagged('key', 'a'), Metric.tagged('key', 'b'))

// v4 snapshot attributes: { key: "a" }
metric.pipe(Metric.withAttributes({ key: 'a' }), Metric.withAttributes({ key: 'b' }))
```

V4 collapses duplicate keys, and the tested composition retained the earlier value. Do not port a
site with duplicate or potentially colliding keys until its intended cardinality and precedence
are explicit. Schema/object-field-derived labels with unique field names can move directly to
attributes.

## Intended differences

None for unique-key metrics. Counter totals, gauge values, instrument metadata, attributes, and
series cardinality must be preserved.

Duplicate-key labels have no equivalent representation in v4 attributes. No current migration
decision authorizes silently collapsing them.

## Gotchas

- `Metric.update` means “apply the metric's input”, not always “replace”. It adds to counters,
  replaces gauges, records histogram observations, and increments frequency occurrences.
- Do not replace `incrementBy(metric, amount)` with `update(metric, 1)`.
- Do not discard labels merely because `MetricLabel` is absent. The replacement is attributes.
- Do not compare only an in-process value. Metrics are telemetry: verify exporter-visible metadata,
  attributes, values, and series count.
- Tuple attributes are converted to a string-keyed attribute set. Validate uniqueness before
  conversion when keys are dynamic.

## Codemod rule

The three mutation replacements are mechanical after confirming the metric kind. Label migration
requires changing the producer and consumer types together and reviewing duplicate-key behavior.
