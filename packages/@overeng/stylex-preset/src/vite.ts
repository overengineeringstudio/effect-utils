import { unplugin as stylex } from '@stylexjs/unplugin'
import type { Plugin } from 'vite'

/**
 * Creates the StyleX Vite plugin configured to compile this preset and any
 * additional external packages that ship uncompiled StyleX source.
 */
export const createStylexVitePlugin = ({
  externalPackages = [],
}: { externalPackages?: readonly string[] } = {}): Plugin => {
  const deduplicatedExternalPackages = [...new Set(['@overeng/stylex-preset', ...externalPackages])]
  // `externalPackages` is supported at runtime (unplugin core destructures it)
  // but missing from @stylexjs/unplugin@0.19 UserOptions typings.
  const stylexOptions = {
    externalPackages: deduplicatedExternalPackages,
  } as Parameters<typeof stylex.vite>[0]

  return stylex.vite(stylexOptions)
}
