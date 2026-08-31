import { unplugin as stylex } from '@stylexjs/unplugin'
/** @import { Plugin } from 'vite' */

/**
 * Creates the StyleX Vite plugin configured to compile this preset and any
 * additional external packages that ship uncompiled StyleX source.
 *
 * @param {{ externalPackages?: readonly string[] }} [options]
 * @returns {Plugin}
 */
export const createStylexVitePlugin = ({ externalPackages = [] } = {}) => {
  const deduplicatedExternalPackages = [...new Set(['@overeng/stylex-preset', ...externalPackages])]
  // `externalPackages` is supported at runtime (unplugin core destructures it)
  // but missing from @stylexjs/unplugin@0.19 UserOptions typings.
  const stylexOptions = /** @type {Parameters<typeof stylex.vite>[0]} */ ({
    externalPackages: deduplicatedExternalPackages,
  })

  return stylex.vite(stylexOptions)
}
