import { createGenieOutput } from '../core.ts'
import type { GenieContext, GenieOutput, Strict } from '../mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

/** The committed JSON shape: a plain key/value object (arrays and primitives at the top level are rejected). */
export type ProjectionJsonObject = { readonly [key: string]: unknown }

/** Validator input: the typed source data plus the schema-versioned projection that is actually written to disk. */
export type ProjectionArtifactValidatorArgs<TData, TProjection extends ProjectionJsonObject> = {
  data: TData
  projection: TProjection & { readonly schemaVersion: number }
  ctx: GenieContext
}

/** Pure validator over a projection; returns issues to surface rather than throwing. */
export type ProjectionArtifactValidator<TData, TProjection extends ProjectionJsonObject> = (
  args: ProjectionArtifactValidatorArgs<TData, TProjection>,
) => readonly GenieValidationIssue[]

/** Configuration for `projectionArtifact.json`: source data, schema version, optional projection and validators. */
export type ProjectionJsonArtifactArgs<TData, TProjection extends ProjectionJsonObject> = {
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: TData
  /** Schema version for downstream consumers. */
  schemaVersion: number
  /** Optional projection for deriving the committed cross-boundary JSON object. */
  project?: (data: TData) => TProjection
  /** Optional generic validators over the schema-versioned projection. */
  validators?: readonly ProjectionArtifactValidator<TData, TProjection>[]
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

function projectionArtifactJson<
  const TData,
  const TProjection extends ProjectionJsonObject = TData & ProjectionJsonObject,
>(
  args: Strict<
    ProjectionJsonArtifactArgs<TData, TProjection>,
    ProjectionJsonArtifactArgs<TData, TProjection>
  >,
): GenieOutput<TData> {
  return createGenieOutput({
    data: args.data,
    stringify: (_ctx) => {
      const projected = projectData(args)
      const projection = withSchemaVersion(projected, args.schemaVersion)

      return JSON.stringify(stableJsonValue(projection), null, args.indentation ?? 2) + '\n'
    },
    validate: (ctx) => {
      const projected = projectData(args)
      const projection = withSchemaVersion(projected, args.schemaVersion)

      return (args.validators ?? []).flatMap((validator) =>
        validator({
          data: args.data,
          projection,
          ctx,
        }),
      )
    },
  })
}

function projectData<TData, TProjection extends ProjectionJsonObject>(
  args: ProjectionJsonArtifactArgs<TData, TProjection>,
): TProjection {
  return (
    args.project === undefined ? asJsonObject(args.data) : args.project(args.data)
  ) as TProjection
}

/** Entry point for projection-backed artifacts; `.json` emits stable, schema-versioned JSON while keeping typed `.data`. */
export const projectionArtifact = {
  json: projectionArtifactJson,
} as const

/** Identity helper that pins `TData`/`TProjection` inference for a validator without widening the callback types. */
export function defineProjectionValidator<TData, TProjection extends ProjectionJsonObject>(
  validator: ProjectionArtifactValidator<TData, TProjection>,
): ProjectionArtifactValidator<TData, TProjection> {
  return validator
}

/** Reusable validators over projections; `uniqueValues` flags duplicate values in a derived list. */
export const projectionValidators = {
  uniqueValues: <TData, TProjection extends ProjectionJsonObject>(args: {
    rule: string
    label: string
    values: (args: ProjectionArtifactValidatorArgs<TData, TProjection>) => readonly string[]
  }): ProjectionArtifactValidator<TData, TProjection> =>
    defineProjectionValidator((validatorArgs) => {
      const seen = new Set<string>()
      const issues: GenieValidationIssue[] = []

      for (const value of args.values(validatorArgs)) {
        if (seen.has(value) === true) {
          issues.push({
            severity: 'error',
            packageName: validatorArgs.ctx.location,
            dependency: args.label,
            message: `Duplicate projection value in ${args.label}: ${value}`,
            rule: args.rule,
          })
        }

        seen.add(value)
      }

      return issues
    }),
} as const

function withSchemaVersion<TProjection extends ProjectionJsonObject>(
  projection: TProjection,
  schemaVersion: number,
): TProjection & { readonly schemaVersion: number } {
  return {
    ...projection,
    schemaVersion,
  }
}

function asJsonObject(value: unknown): ProjectionJsonObject {
  if (value === null || Array.isArray(value) === true || typeof value !== 'object') {
    throw new Error('projectionArtifact.json data must project to a JSON object')
  }

  return value as ProjectionJsonObject
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value) === true) {
    return value.map(stableJsonValue)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, stableJsonValue(nestedValue)]),
  )
}
