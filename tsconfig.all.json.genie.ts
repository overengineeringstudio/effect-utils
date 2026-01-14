import { tsconfigJson } from './packages/@overeng/genie/src/runtime/mod.ts'

const references = [
  './scripts',
  './context/effect/socket',
  './context/opentui',
  './packages/@overeng/genie',
  './packages/@overeng/mono',
  './packages/@overeng/dotdot',
  './packages/@overeng/notion-effect-schema',
  './packages/@overeng/notion-cli',
  './packages/@overeng/notion-effect-client',
  './packages/@overeng/effect-ai-claude-cli',
  './packages/@overeng/effect-schema-form',
  './packages/@overeng/effect-schema-form-aria',
  './packages/@overeng/effect-react',
  './packages/@overeng/react-inspector',
  './packages/@overeng/utils',
  './packages/@overeng/oxc-config',
  './packages/@overeng/effect-path',
  './packages/@overeng/effect-rpc-tanstack',
  './packages/@overeng/effect-rpc-tanstack/examples/basic',
]

// This file is meant for convenience to built all TS projects in the workspace at once
export default tsconfigJson({
  references: references.map((path) => ({ path })),
  files: [],
})
