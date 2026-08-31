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
      // Storybook 10.4.6 exact-pins unplugin 2.3.11 while the StyleX preset
      // uses v3. Both majors are required until Storybook updates. See #1155.
      reason:
        '@storybook/csf-plugin@10.4.6 exact-pins unplugin@2.3.11 while @overeng/stylex-preset uses catalog unplugin@3.0.0',
      issue: '#1155',
    },
  ],
  ...commonPnpmWorkspaceData,
})
