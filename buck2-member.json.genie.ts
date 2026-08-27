import { projectionArtifact } from './packages/@overeng/genie/src/runtime/mod.ts'
import {
  COMPOSITION_ROOT_SCHEMA_VERSION,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifestJson,
  type BuckMemberManifest,
} from './packages/@overeng/megarepo/src/lib/generators/composition-root.ts'

const buckMemberSchemaVersion = COMPOSITION_ROOT_SCHEMA_VERSION

const manifestProjection = {
  cell: 'effect_utils',
  mount: 'repos/effect-utils',
  projectIgnore: [
    '**/__pycache__',
    '**/dist',
    '**/node_modules',
    '**/node_modules/**',
    '**/target',
    '**/target/**',
    '.devenv',
    '.git',
    'buck-out',
    'node_modules',
    'packages/.editor-view',
    'target',
    'tmp',
  ],
  distOverlays: [
    {
      target: '//packages/@overeng/tui-core:dist',
      destination: 'packages/@overeng/tui-core/dist',
    },
  ],
  capabilities: [
    {
      toolId: 'archive-tool',
      protocol: 'effect-utils/buck2-archive-tool/v1',
      flakePackage: 'buck2-archive-tool',
      executable: 'bin/buck2-archive-tool',
    },
    {
      toolId: 'buck2',
      protocol: 'facebook/buck2-cli/2026-08-22',
      flakePackage: 'buck2',
      executable: 'bin/buck2',
    },
    {
      toolId: 'product',
      protocol: 'effect-utils/buck2-product/v1',
      flakePackage: 'buck2-product',
      executable: 'bin/buck2-product',
    },
  ],
} as const satisfies Omit<BuckMemberManifest, 'schemaVersion'>

const manifestArtifact = projectionArtifact.json({
  schemaVersion: buckMemberSchemaVersion,
  data: manifestProjection,
  project: (projection) =>
    decodeBuckMemberManifest({ schemaVersion: buckMemberSchemaVersion, ...projection }),
  validators: [
    ({ projection: schemaVersionedProjection, ctx }) => {
      const { schemaVersion, ...projection } = schemaVersionedProjection

      try {
        decodeBuckMemberManifest({ schemaVersion, ...projection })
        return []
      } catch (error) {
        return [
          {
            severity: 'error' as const,
            packageName: ctx.location,
            dependency: 'buck2-member.json',
            message: error instanceof Error ? error.message : String(error),
            rule: 'buck-member-manifest-schema',
          },
        ]
      }
    },
  ],
})

export default {
  ...manifestArtifact,
  stringify: (ctx) =>
    encodeBuckMemberManifestJson(decodeBuckMemberManifestJson(manifestArtifact.stringify(ctx))),
} satisfies typeof manifestArtifact
