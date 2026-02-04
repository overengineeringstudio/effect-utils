import { baseOxfmtIgnorePatterns, baseOxfmtOptions } from './genie/oxfmt-base.ts'
import { oxfmtConfig, type OxfmtConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

export default oxfmtConfig({
  ...baseOxfmtOptions,
  ignorePatterns: baseOxfmtIgnorePatterns,
} satisfies OxfmtConfigArgs)
