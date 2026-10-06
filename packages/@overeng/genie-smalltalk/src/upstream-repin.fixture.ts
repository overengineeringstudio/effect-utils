import { emit, mission } from './mod.ts'

/** Synthetic public fixture; independent KDL exercises the same bounded waiting graph. */
export const upstreamRepinKdl = `version 2
mission "example/upstream-repin" state="ready" timeout="720h" {
  goal "Wait for upstream readiness, then update and verify the selected revision."
  constraint "Only modify the selected worktree."
  constraint "Do not merge or deploy."
  step "install-gate" {
    agentless
    retry { attempts 3; backoff "5m"; }
    gate "the readiness helper is installed" {
      exec "printf ready > readiness-helper"
      host "local"
      workspace "\${ST_WORKSPACE}"
      env { CHECK_STYLE "plain"; }
      time-limit "3m"
    }
  }
  loop "await-upstream" timeout="720h" {
    depends-on { step "install-gate" completed; }
    max-rounds 100
    until {
      gate "upstream is ready" {
        exec "test -f ready # round \${loop.round}"
        host "local"
        workspace "\${ST_WORKSPACE}"
        env { CHECK_STYLE "plain"; }
        time-limit "3m"
      }
    }
    round {
      completion { when "all-steps-exhausted" }
      step "settle" {
        agentless
        retry { attempts 100; backoff "10m"; }
        gate "readiness changed or the heartbeat is due" {
          exec "test -f heartbeat # round \${loop.round}"
          host "local"
          workspace "\${ST_WORKSPACE}"
          env { CHECK_STYLE "plain"; }
          time-limit "3m"
        }
      }
    }
    on-exhausted {
      fail
      attention "Upstream is still unavailable after 100 checks" {
        reviewer "person/reviewer"
        severity "warning"
      }
    }
  }
  step "repin" timeout="16h" {
    assigned-to "agent/example/updater"
    depends-on { step "await-upstream" completed; }
    goal "Update the selected dependency to the upstream revision."
    goal "Run the package checks and record their results."
    goal "Publish the verified change without merging it."
  }
}
`

const check = ({ name, command }: { readonly name: string; readonly command: string }) => ({
  name, kind: 'exec' as const, command, host: 'local', workspace: '${ST_WORKSPACE}',
  env: { CHECK_STYLE: 'plain' }, timeLimit: '3m',
})

/** Complete typed equivalent of the independent synthetic KDL above. */
export const upstreamRepin = (): string => emit([mission({
  id: 'example/upstream-repin', state: 'ready', timeout: '720h',
  goals: ['Wait for upstream readiness, then update and verify the selected revision.'],
  constraints: ['Only modify the selected worktree.', 'Do not merge or deploy.'],
  steps: [
    {
      id: 'install-gate', agentless: true, retry: { attempts: 3, backoff: '5m' },
      gates: [check({ name: 'the readiness helper is installed', command: 'printf ready > readiness-helper' })],
    },
    {
      id: 'await-upstream', timeout: '720h',
      dependsOn: [{ step: 'install-gate', state: 'completed' }], maxRounds: 100,
      until: [check({ name: 'upstream is ready', command: 'test -f ready # round ${loop.round}' })],
      round: {
        completion: { when: 'all-steps-exhausted' },
        steps: [{
          id: 'settle', agentless: true, retry: { attempts: 100, backoff: '10m' },
          gates: [check({ name: 'readiness changed or the heartbeat is due', command: 'test -f heartbeat # round ${loop.round}' })],
        }],
      },
      onExhausted: { outcome: 'fail', attention: {
        title: 'Upstream is still unavailable after 100 checks',
        reviewer: 'person/reviewer', severity: 'warning',
      } },
    },
    {
      id: 'repin', timeout: '16h', assignedTo: 'agent/example/updater',
      dependsOn: [{ step: 'await-upstream', state: 'completed' }],
      goals: [
        'Update the selected dependency to the upstream revision.',
        'Run the package checks and record their results.',
        'Publish the verified change without merging it.',
      ],
    },
  ],
})])
