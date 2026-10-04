import { cargoBuck2PackageProjection } from '../../buck2-tools/core/cargo-buck2-package-projection.ts'

export default cargoBuck2PackageProjection({
  sourceUrl: import.meta.url,
  wasmBindgen: {
    name: 'wasm',
    outName: 'effect_rust_fixture',
    smoke: { script: '//rust/effect-rust-fixtures:smoke', runtimes: ['node', 'bun'] },
  },
  wasmGuest: {
    name: 'guest',
    productName: 'effect-rust-fixture-wasm-guest',
    entrypoint: 'lib/effect-rust-fixture.wasm',
    harness: 'effect-utils/rust-interop-host/v1',
    recipe: 'effect-utils/rust-wasm-guest/v1',
    toolchain: 'effect-utils/buck2-rust-wasm-toolchain/v1',
  },
})
