/** Build capabilities declared by the product rules, not the development shell. */
export const productBuildCapabilities = (product: {
  readonly kind: 'native' | 'compiled-executable' | 'javascript' | 'package'
  readonly cargoWorkspaceRoot?: string
}): readonly string[] => {
  const pnpm = ['action-env', 'archive-tool', 'bun']
  const capabilities =
    product.kind === 'native' && product.cargoWorkspaceRoot !== undefined
      ? [
          'archive-tool',
          'bun',
          'product',
          'python-bootstrap',
          // native_rust_toolchains declares the complete native/wasm toolchain pair.
          'rust-archiver',
          'rust-c-compiler',
          'rust-clippy-driver',
          'rust-compiler',
          'rust-cxx-compiler',
          'rust-dwp',
          'rust-linker',
          'rust-nm',
          'rust-objcopy',
          'rust-objdump',
          'rust-ranlib',
          'rust-rustdoc',
          'rust-shell',
          'rust-strip',
          'rust-wasm-compiler',
          'rust-wasm-linker',
          'rust-wasm-rustdoc',
        ]
      : product.kind === 'native'
        ? [...pnpm, 'product']
        : product.kind === 'compiled-executable'
          ? [...pnpm, 'bun-compile-runtime', 'product']
          : product.kind === 'package'
            ? [...pnpm, 'buck2-fingerprint', 'effect-tsgo', 'product']
            : pnpm
  return capabilities.toSorted()
}
