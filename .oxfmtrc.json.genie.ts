import { baseOxfmtIgnorePatterns, baseOxfmtOptions } from './genie/oxfmt-base.ts'
import { oxfmtConfig } from './packages/@overeng/genie/src/runtime/mod.ts'

export default oxfmtConfig({
  ...baseOxfmtOptions,
  ignorePatterns: baseOxfmtIgnorePatterns,
})
