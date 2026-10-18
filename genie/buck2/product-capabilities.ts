type ProductCapabilityShape = {
  readonly kind: 'native' | 'compiled-executable' | 'javascript' | 'package'
  readonly cargoWorkspaceRoot?: string
}

/** Pnpm-backed products materialize package trees through sandboxed TS actions. */
const usesTsSandbox = (product: ProductCapabilityShape): boolean =>
  !(product.kind === 'native' && product.cargoWorkspaceRoot !== undefined)

/**
 * The TS action sandbox base set (`buck2/toolchains/ts_sandbox.bzl`), excluding
 * Linux-only Bubblewrap. Action tools such as effect-tsgo are declared by the
 * product kinds that run them, so package trees never depend on those tools.
 */
export const tsSandboxCapabilities = ['bun', 'rust-shell'] as const

/** Build capabilities declared by the product rules, not the development shell. */
export const productBuildCapabilities = (product: ProductCapabilityShape): readonly string[] => {
  const pnpm = ['action-env', 'archive-tool', ...tsSandboxCapabilities]
  const capabilities =
    product.kind === 'native' && product.cargoWorkspaceRoot !== undefined
      ? [
          // Prelude build-script shims need declared Bash and coreutils on PATH.
          'action-env',
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

/**
 * Linux-only build capabilities. Bubblewrap is the TS sandbox's Linux
 * containment; Darwin runs the explicit `darwin-unsandboxed` admission lane.
 */
export const productLinuxBuildCapabilities = (product: ProductCapabilityShape): readonly string[] =>
  usesTsSandbox(product) ? ['bubblewrap'] : []
