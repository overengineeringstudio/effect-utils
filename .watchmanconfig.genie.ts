import { jsonArtifact } from './packages/@overeng/genie/src/runtime/mod.ts'

// Darwin accelerates the first eight exclusions; keep the busiest output roots first.
// Source files and .buck2/capabilities must remain watched.
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
      '.direnv',
      '.git',
    ],
    idle_reap_age_seconds: 3600,
  },
})
