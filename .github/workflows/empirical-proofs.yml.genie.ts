import {
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciWorkflow,
  type CiWorkflowArgs,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { withBuck2CachePostures } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { withPipelineTelemetry } from '../../genie/ci-workflow/pipeline-telemetry.ts'
import { empiricalProofJobs } from './ci.yml.genie.ts'

export default ciWorkflow({
  trustTier: 'public',
  name: 'Empirical Proofs',
  on: {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'reopened', 'synchronize', 'labeled'] },
    schedule: [{ cron: '17 3 * * *' }],
    workflow_dispatch: {
      inputs: {
        ...ciMeasurementBaselineWorkflowDispatchInputs,
        debug_force_nix_diagnostics_failure: {
          description: 'Force post-validation failure to verify proof diagnostics',
          required: false,
          default: false,
          type: 'boolean',
        },
      },
    },
  },
  permissions: { contents: 'read', 'id-token': 'write' },
  jobs: withBuck2CachePostures({
    jobs: withPipelineTelemetry(withBuck2CacheEvidence(empiricalProofJobs)),
    postures: {
      'bootstrap-cold-proof': 'reader',
      'test-megarepo-cold-gc': 'reader',
      'nix-closure-sizes': 'reader',
      'main-source-shape': 'reader',
      'ci-measurements-report': 'reader',
      'devenv-perf': {
        posture: 'reader',
        disabledWhen:
          "github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != ''",
      },
    },
  }),
} satisfies CiWorkflowArgs)
