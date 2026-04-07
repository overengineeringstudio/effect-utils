/** Shared auto-review workflow: requests review from a human when an assistant opens a PR */

import { githubWorkflow } from '../packages/@overeng/genie/src/runtime/mod.ts'
import { defaultActionlintConfig, linuxX64Runner } from './ci-workflow.ts'

/** Generate the shared auto-review workflow used by assistant-authored PRs. */
export const autoReviewWorkflow = ({
  author = 'schickling-assistant',
  reviewer = 'schickling',
} = {}) =>
  githubWorkflow({
    actionlint: defaultActionlintConfig,
    name: 'Auto-request review',
    on: {
      pull_request: {
        types: ['opened', 'ready_for_review'],
      },
    },
    permissions: {
      'pull-requests': 'write',
    },
    jobs: {
      'request-review': {
        if: `github.event.pull_request.user.login == '${author}' && github.event.pull_request.draft == false`,
        'runs-on': linuxX64Runner,
        steps: [
          {
            name: `Request review from ${reviewer}`,
            env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
            run: `nix shell nixpkgs#gh --command gh pr edit \${{ github.event.pull_request.number }} --repo \${{ github.repository }} --add-reviewer ${reviewer}`,
          },
        ],
      },
    },
  })
