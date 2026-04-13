import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { jsonArtifact, type GenieContext } from '../mod.ts'

const mockGenieContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

describe('jsonArtifact', () => {
  it('serializes plain data without requiring a schema', () => {
    const result = jsonArtifact({
      data: {
        vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
      },
    })

    expect(JSON.parse(result.stringify(mockGenieContext))).toEqual({
      vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
    })
  })

  it('keeps typed source data available to TypeScript consumers', () => {
    const DeploySurfaces = Schema.Struct({
      vercelBuildProjects: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          projectIdEnv: Schema.String,
        }),
      ),
    })

    const result = jsonArtifact({
      schema: DeploySurfaces,
      data: {
        vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
      },
    })

    expect(result.data).toEqual({
      vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
    })
  })

  it('serializes through the provided schema', () => {
    const DeploySurfaces = Schema.Struct({
      vercelBuildProjects: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          projectIdEnv: Schema.String,
        }),
      ),
      storybookProjects: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          deployName: Schema.String,
        }),
      ),
    })

    const result = jsonArtifact({
      schema: DeploySurfaces,
      data: {
        vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
        storybookProjects: [{ name: 'app', deployName: 'storybook-app' }],
      },
    })

    expect(JSON.parse(result.stringify(mockGenieContext))).toEqual({
      vercelBuildProjects: [{ name: 'website', projectIdEnv: 'VERCEL_PROJECT_ID_WEBSITE' }],
      storybookProjects: [{ name: 'app', deployName: 'storybook-app' }],
    })
  })
})
