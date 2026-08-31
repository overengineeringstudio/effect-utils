import type { Plugin } from 'vite'

/**
 * Creates the StyleX Vite plugin configured to compile this preset and any
 * additional external packages that ship uncompiled StyleX source.
 */
export declare const createStylexVitePlugin: (options?: {
  externalPackages?: readonly string[]
}) => Plugin
