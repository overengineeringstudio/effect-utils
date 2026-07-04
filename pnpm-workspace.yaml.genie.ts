// @genie-bootstrap
import { catalog } from './genie/external.ts'
import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  catalogVersions: catalog,
  catalogDuplicateExceptions: [
    {
      package: 'string-width',
      // @opentui/core@0.4.1 (latest) pins string-width@7.2.0 exactly, so pnpm
      // dedupe cannot collapse it onto the catalog 8.x. We deliberately do NOT
      // force it via an override: string-width 8 changed wide-char/emoji width
      // computation (dropped emoji-regex, bumped get-east-asian-width), and
      // @opentui/core is a terminal renderer that depends on that width logic —
      // forcing 8.x risks subtle rendering breakage. Blessed instead; revisit
      // when @opentui/core moves to string-width 8.x. See #821.
      reason:
        '@opentui/core@0.4.1 exact-pins string-width@7.2.0; not force-overridden because string-width 8 changes emoji/wide-char width logic that the TUI renderer relies on',
      issue: '#821',
    },
    {
      package: 'strip-ansi',
      // @opentui/core@0.4.1 (latest) pins strip-ansi@7.1.2 exactly while
      // the catalog tracks 7.2.0 for direct consumers. Keep the catalog current
      // for Genie's runtime closure, and do not force the renderer's dependency
      // graph until OpenTUI moves.
      reason:
        '@opentui/core@0.4.1 exact-pins strip-ansi@7.1.2; not force-overridden because it is part of the upstream terminal renderer dependency graph',
      issue: '#821',
    },
    {
      package: 'ws',
      // react-devtools-core@7.0.1 exact-pins ws@7.5.10, so pnpm dedupe cannot
      // collapse it onto the catalog 8.x. Keep the catalog on ws 8.x for our
      // direct consumers and revisit when react-devtools-core updates.
      reason:
        'react-devtools-core@7.0.1 exact-pins ws@7.5.10; not force-overridden because it is an upstream devtools transport dependency',
      issue: '#821',
    },
  ],
  ...commonPnpmWorkspaceData,
})
