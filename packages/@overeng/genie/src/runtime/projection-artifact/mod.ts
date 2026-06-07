import { createGenieOutput } from '../core.ts'
import type { GenieContext, GenieOutput, Strict } from '../mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

export type ProjectionJsonObject = { readonly [key: string]: unknown }

export type ProjectionArtifactValidatorArgs<TData, TProjection extends ProjectionJsonObject> = {
  data: TData
  projection: TProjection & { readonly schemaVersion: number }
  ctx: GenieContext
}

export type ProjectionArtifactValidator<TData, TProjection extends ProjectionJsonObject> = (
  args: ProjectionArtifactValidatorArgs<TData, TProjection>,
) => readonly GenieValidationIssue[]

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

export const projectionArtifact = {
  json: projectionArtifactJson,
} as const

export function defineProjectionValidator<TData, TProjection extends ProjectionJsonObject>(
  validator: ProjectionArtifactValidator<TData, TProjection>,
): ProjectionArtifactValidator<TData, TProjection> {
  return validator
}

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
        if (seen.has(value)) {
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
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('projectionArtifact.json data must project to a JSON object')
  }

  return value as ProjectionJsonObject
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, stableJsonValue(nestedValue)]),
  )
}
