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
    // Pnpm install descriptor fixtures pin the exact Bun YAML/JSON encoder
    // bytes used as Buck action keys; formatting would invalidate the oracle.
    'packages/@overeng/buck2-tools/src/__fixtures__/pnpm-install-descriptor/**',
  ],
} satisfies OxfmtConfigArgs)
