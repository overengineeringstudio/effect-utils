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
      package: 'unplugin',
      // @storybook/csf-plugin@10.5.10 still declares unplugin ^2.3.5, which
      // resolves to 2.3.11, while our StyleX build integration uses v3. Both
      // majors are required until Storybook updates. Checked against 10.5.10
      // rather than assumed: the bump does not retire this exception. The
      // consuming package is deliberately not named — it is moving as part of
      // the StyleX work, and the exception is keyed by `unplugin` regardless.
      // See #1155.
      reason:
        '@storybook/csf-plugin@10.5.10 declares unplugin ^2.3.5 (resolves 2.3.11) while our StyleX build integration uses catalog unplugin@3.0.0',
      issue: '#1155',
    },
  ],
  ...commonPnpmWorkspaceData,
})
