/** Shared auto-review workflow: requests review from a human when an assistant opens a PR */

import { githubWorkflow } from '../packages/@overeng/genie/src/runtime/mod.ts'

export const autoReviewWorkflow = ({
  author = 'schickling-assistant',
  reviewer = 'schickling',
} = {}) =>
  githubWorkflow({
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
        'runs-on': 'ubuntu-latest',
        steps: [
          {
            name: `Request review from ${reviewer}`,
            env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
            run: `gh pr edit \${{ github.event.pull_request.number }} --repo \${{ github.repository }} --add-reviewer ${reviewer}`,
          },
        ],
      },
    },
  })
