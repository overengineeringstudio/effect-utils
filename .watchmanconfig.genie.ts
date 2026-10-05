import { jsonArtifact } from './packages/@overeng/genie/src/runtime/mod.ts'

// macOS accelerates only the first eight exclusions; keep the busiest roots first.
// Sources and .buck2/capabilities must remain watched.
export default jsonArtifact({
  data: {
    ignore_dirs: [
      'packages/.editor-view',
      '.editor-view',
      'context/.editor-view',
      'buck-out',
      '.devenv',
      'target',
      'tmp',
      'node_modules',
      '.git',
    ],
  },
})
