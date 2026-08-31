import { baseOxfmtIgnorePatterns, baseOxfmtOptions } from './genie/oxfmt-base.ts'
import { oxfmtConfig, type OxfmtConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

export default oxfmtConfig({
  ...baseOxfmtOptions,
  ignorePatterns: [
    ...baseOxfmtIgnorePatterns,
    // otelite golden/mock fixtures are byte-exact OTLP/CLI data asserted against
    // by the Rust conformance tests (tests/goldens.rs, tests/m6_goldens.rs);
    // reformatting them would break those tests, so they must stay as-is.
    'packages/@overeng/otelite/tests/conformance/**',
  ],
} satisfies OxfmtConfigArgs)
