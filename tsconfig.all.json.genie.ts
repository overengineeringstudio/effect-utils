import { tsconfigJson } from './packages/@overeng/genie/src/runtime/mod.ts'

// All packages must be listed here to ensure TypeScript's incremental build
// properly detects cross-package changes. Missing packages can cause stale
// .tsbuildinfo caches where signature changes aren't detected in dependents.
const references = [
  './context/effect/socket',
  './context/opentui',
  './packages/@overeng/cli-ui',
  './packages/@overeng/effect-ai-claude-cli',
  './packages/@overeng/effect-path',
  './packages/@overeng/effect-react',
  './packages/@overeng/effect-rpc-tanstack',
  './packages/@overeng/effect-rpc-tanstack/examples/basic',
  './packages/@overeng/effect-schema-form',
  './packages/@overeng/effect-schema-form-aria',
  './packages/@overeng/genie',
  './packages/@overeng/megarepo',
  './packages/@overeng/mono',
  './packages/@overeng/notion-cli',
  './packages/@overeng/notion-effect-client',
  './packages/@overeng/notion-effect-schema',
  './packages/@overeng/oxc-config',
  './packages/@overeng/react-inspector',
  './packages/@overeng/utils',
]

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  references: references.map((path) => ({ path })),
  files: [],
})
