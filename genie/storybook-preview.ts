/**
 * Shared configuration for the split Storybook preview workflows:
 * - `.github/workflows/storybook-preview-build.yml` (uncredentialed `pull_request`)
 * - `.github/workflows/storybook-preview-deploy.yml` (trusted `workflow_run`)
 */
import { existsSync } from 'node:fs'

import { rootWorkspacePackages } from '../package.json.genie.ts'
import { projectPnpmPackageClosure } from '../packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts'
import {
  cachixCliBuildStep,
  cachixStep,
  installNixStep,
  namespaceRunner,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  readBinaryCacheDescriptors,
  validateNixStoreStep,
} from './ci-workflow.ts'

/** Must match the build workflow `name:`; the deploy workflow triggers on it. */
export const storybookPreviewBuildWorkflowName = 'Storybook Preview Build'

/**
 * Discover Storybook consumers and project their complete workspace closure,
 * including development dependencies (shared Storybook config lives there).
 * Genie freshness therefore covers new packages and dependency-edge changes.
 */
export const storybookPaths = [
  ...new Set(
    rootWorkspacePackages
      .filter((pkg) =>
        existsSync(new URL(`../${pkg.meta.workspace.memberPath}/.storybook`, import.meta.url)),
      )
      .flatMap((pkg) =>
        projectPnpmPackageClosure({ pkg }).workspaceClosureDirs.map((path) => `${path}/**`),
      ),
  ),
  '.github/workflows/storybook-*.yml',
  '.github/workflows/storybook-*.yml.genie.ts',
  'genie/storybook-preview.ts',
  'genie/ci-workflow.ts',
  'genie/ci-workflow/**',
  'genie/ci-scripts/**',
  'genie/deploy-preview/**',
  'genie/external.ts',
  'genie/internal.ts',
  'genie/packages.ts',
  'package.json',
  'package.json.genie.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yaml.genie.ts',
  'patches/**',
  'devenv.nix',
  'devenv.yaml',
  'devenv.lock',
  'flake.nix',
  'flake.lock',
  'nix/devenv-modules/tasks/shared/storybook.nix',
  'nix/devenv-modules/tasks/shared/netlify.nix',
  'nix/binary-caches.json',
].toSorted()

/**
 * Hosted admission job: never occupies Namespace for an unrelated PR. The API
 * is paginated; renames consider both names. Beyond GitHub's 3,000-file API cap,
 * run conservatively. Main pushes keep their existing unconditional coverage.
 */
export const storybookChangesJob = {
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 5,
  permissions: { contents: 'read', 'pull-requests': 'read' },
  defaults: { run: { shell: 'bash' } },
  outputs: { changed: '${{ steps.changes.outputs.changed }}' },
  steps: [
    {
      id: 'changes',
      name: 'Check Storybook inputs',
      env: {
        GH_TOKEN: '${{ github.token }}',
        GH_REPO: '${{ github.repository }}',
        STORYBOOK_PATHS: JSON.stringify(storybookPaths),
      },
      run: `if [[ "$GITHUB_EVENT_NAME" != pull_request ]] || \
[[ "$(jq '.pull_request.changed_files' "$GITHUB_EVENT_PATH")" -gt 3000 ]]; then
  echo 'changed=true' >> "$GITHUB_OUTPUT"
  exit 0
fi
pr="$(jq '.pull_request.number' "$GITHUB_EVENT_PATH")"
gh api --paginate "repos/$GH_REPO/pulls/$pr/files?per_page=100" \\
  --jq '.[] | .filename, (.previous_filename // empty)' > "$RUNNER_TEMP/storybook-changed-files"
mapfile -t patterns < <(jq -r '.[]' <<< "$STORYBOOK_PATHS")
changed=false
while IFS= read -r file; do
  for pattern in "\${patterns[@]}"; do
    if [[ "$file" == $pattern ]]; then
      changed=true
      break 2
    fi
  done
done < "$RUNNER_TEMP/storybook-changed-files"
echo "changed=$changed" >> "$GITHUB_OUTPUT"`,
    },
  ],
} as const

export const storybookPreviewRunner = namespaceRunner({
  profile: 'namespace-profile-linux-x86-64',
  runId: '${{ github.run_id }}',
})

const binaryCache = readBinaryCacheDescriptors(
  new URL('../nix/binary-caches.json', import.meta.url),
)['overeng-effect-utils']!

/** Nix + devenv setup after checkout. Read-only caches; no secrets. */
export const storybookPreviewSetupSteps = [
  installNixStep({ binaryCaches: [binaryCache] }),
  cachixCliBuildStep,
  cachixStep({ name: 'overeng-effect-utils' }),
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
] as const
