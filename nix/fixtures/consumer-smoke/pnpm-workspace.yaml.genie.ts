import { pnpmWorkspaceYaml } from '../../../genie/external.ts'

export default pnpmWorkspaceYaml.root({
  repoName: 'consumer-smoke',
  packages: [],
  extraMembers: ['.'],
  allowBuilds: {},
  ignoreScripts: true,
  enableGlobalVirtualStore: false,
  nodeLinker: 'isolated',
  pmOnFail: 'ignore',
})
