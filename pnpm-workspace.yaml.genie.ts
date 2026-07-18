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
      package: 'effect',
      versions: ['3.21.4', '4.0.0-beta.99'],
      isolatedVersions: ['4.0.0-beta.99'],
      // The inspector directly consumes Effect 4 schemas from LiveStore. Keep
      // an exact Effect 4 development install for its tests while the published
      // package uses the consumer's peer instance; never cast across majors.
      reason:
        '@overeng/react-inspector tests against Effect 4 while the repository catalog remains on Effect 3; published consumers provide Effect through its peer contract',
      issue: '#937',
    },
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
  ],
  ...commonPnpmWorkspaceData,
})
