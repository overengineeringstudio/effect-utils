import { cargoBuck2PackageProjection } from '../../buck2-tools/core/cargo-buck2-package-projection.ts'

export default cargoBuck2PackageProjection({
  sourceUrl: import.meta.url,
  wasmBindgen: {
    name: 'wasm',
    outName: 'effect_rust_fixture',
    visibility: ['PUBLIC'],
    smoke: { script: '//rust/effect-rust-fixtures:smoke', runtimes: ['node', 'bun'] },
  },
})
