// Shared scaffold + fixed strings for the md demo specs. The core propagation
// demo (`e2e.spec.ts`) and the guarded-merge proof (`e2e.merge-proof.spec.ts`)
// both bind the same pages/reset and reuse these constants.

// Must match seed/*.nmd + reset.sh output.
export const TODO = 'Finalize the API spec'
export const STATUS_BASE = 'On track for the Q3 release.'
export const STATUS_REMOTE = 'Slipping — blocked on review.'
export const STATUS_LOCAL = 'Ready to ship today.'
export const NEW_ENDPOINT = 'DELETE /v1/pages'

/** Common `Demo` fields (everything except id/title/beats). */
export const mdScaffold = {
  demoRel: 'demo/md',
  stageRel: 'demo/md/stage',
  resetRel: 'demo/md/reset.sh',
  watchLog: 'watch.log',
  pages: [
    { role: 'roadmap', nmdFile: 'roadmap.nmd' },
    { role: 'spec', nmdFile: 'spec.nmd' },
  ],
} as const
