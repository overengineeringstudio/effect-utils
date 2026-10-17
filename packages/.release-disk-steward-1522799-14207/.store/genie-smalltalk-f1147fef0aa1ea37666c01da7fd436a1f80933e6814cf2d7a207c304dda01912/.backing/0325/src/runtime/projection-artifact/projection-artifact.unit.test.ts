import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  defineProjectionValidator,
  projectionArtifact,
  projectionValidators,
  type GenieContext,
} from '../mod.ts'

const mockGenieContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

describe('projectionArtifact.json', () => {
  it('adds a schema version and serializes keys deterministically', () => {
    const left = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        zebra: { beta: 2, alpha: 1 },
        alpha: [{ z: true, a: false }],
      },
    })

    const right = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        alpha: [{ a: false, z: true }],
        zebra: { alpha: 1, beta: 2 },
      },
    })

    expect(left.stringify(mockGenieContext)).toBe(right.stringify(mockGenieContext))
    expect(left.stringify(mockGenieContext)).toMatchInlineSnapshot(`
      "{
        "alpha": [
          {
            "a": false,
            "z": true
          }
        ],
        "schemaVersion": 1,
        "zebra": {
          "alpha": 1,
          "beta": 2
        }
      }
      "
    `)
  })

  it('keeps typed source data available to TypeScript consumers', () => {
    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        deploySurfaces: [{ name: 'website' }],
      },
    })

    expect(result.data).toEqual({
      deploySurfaces: [{ name: 'website' }],
    })
  })

  it('keeps the declared schema version authoritative', () => {
    const result = projectionArtifact.json({
      schemaVersion: 2,
      data: {
        schemaVersion: 1,
        deploySurfaces: [{ name: 'website' }],
      },
    })

    expect(JSON.parse(result.stringify(mockGenieContext))).toEqual({
      schemaVersion: 2,
      deploySurfaces: [{ name: 'website' }],
    })
  })

  it('projects source data before serialization', () => {
    const Projection = Schema.Struct({
      deploySurfaces: Schema.Array(
        Schema.Struct({
          name: Schema.String,
        }),
      ),
    })

    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        ignoredByProjection: true,
        deploySurfaces: [{ name: 'website' }],
      },
      project: Schema.encodeSync(Projection),
    })

    expect(JSON.parse(result.stringify(mockGenieContext))).toEqual({
      schemaVersion: 1,
      deploySurfaces: [{ name: 'website' }],
    })
  })

  it('runs validators against the schema-versioned projection', () => {
    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        deploySurfaces: [],
      },
      validators: [
        defineProjectionValidator((_args) => [
          {
            severity: 'error',
            packageName: 'projection',
            dependency: 'deploySurfaces',
            message: 'expected at least one deploy surface',
            rule: 'deploy-surfaces-present',
          },
        ]),
      ],
    })

    expect(result.validate?.(mockGenieContext)).toEqual([
      {
        severity: 'error',
        packageName: 'projection',
        dependency: 'deploySurfaces',
        message: 'expected at least one deploy surface',
        rule: 'deploy-surfaces-present',
      },
    ])
  })

  it('passes source data, projection, and context to validators', () => {
    const result = projectionArtifact.json({
      schemaVersion: 3,
      data: {
        deploySurfaces: [{ name: 'website' }],
      },
      validators: [
        defineProjectionValidator((args) => {
          if (
            args.ctx.cwd === '/workspace' &&
            args.data.deploySurfaces[0]?.name === 'website' &&
            args.projection.schemaVersion === 3
          ) {
            return []
          }

          return [
            {
              severity: 'error',
              packageName: 'projection',
              dependency: 'context',
              message: 'validator args were not passed through',
              rule: 'projection-validator-args',
            },
          ]
        }),
      ],
    })

    expect(result.validate?.(mockGenieContext)).toEqual([])
  })

  it('fails duplicate values with projectionValidators.uniqueValues', () => {
    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        deploySurfaces: [{ name: 'website' }, { name: 'website' }],
      },
      validators: [
        projectionValidators.uniqueValues({
          rule: 'deploy-surface-name-unique',
          label: 'deploy surface names',
          values: (args) => args.data.deploySurfaces.map((surface) => surface.name),
        }),
      ],
    })

    expect(result.validate?.(mockGenieContext)).toEqual([
      {
        severity: 'error',
        packageName: '.',
        dependency: 'deploy surface names',
        message: 'Duplicate projection value in deploy surface names: website',
        rule: 'deploy-surface-name-unique',
      },
    ])
  })

  it('aggregates multiple validator issues', () => {
    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: {
        names: ['website', 'website'],
      },
      validators: [
        projectionValidators.uniqueValues({
          rule: 'name-unique',
          label: 'names',
          values: (args) => args.data.names,
        }),
        defineProjectionValidator(() => [
          {
            severity: 'warning',
            packageName: 'projection',
            dependency: 'names',
            message: 'projection has no display names',
            rule: 'display-name-present',
          },
        ]),
      ],
    })

    expect(result.validate?.(mockGenieContext)).toEqual([
      {
        severity: 'error',
        packageName: '.',
        dependency: 'names',
        message: 'Duplicate projection value in names: website',
        rule: 'name-unique',
      },
      {
        severity: 'warning',
        packageName: 'projection',
        dependency: 'names',
        message: 'projection has no display names',
        rule: 'display-name-present',
      },
    ])
  })

  it('requires projection data to encode to a JSON object', () => {
    const result = projectionArtifact.json({
      schemaVersion: 1,
      data: ['website'],
    })

    expect(() => result.stringify(mockGenieContext)).toThrow(
      'projectionArtifact.json data must project to a JSON object',
    )
  })
})
