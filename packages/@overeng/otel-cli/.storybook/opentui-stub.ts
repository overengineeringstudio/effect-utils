/**
 * OpenTUI stub for Storybook
 *
 * OpenTUI requires Bun runtime and uses import syntax not supported by Vite/esbuild.
 * This stub provides empty exports so Storybook can build without errors.
 */

// Stub exports - these will never be called in Storybook context
export const createCliRenderer = () => {
  throw new Error('OpenTUI is not available in Storybook. Use Bun runtime for OpenTUI features.')
}

export const createRoot = () => {
  throw new Error('OpenTUI is not available in Storybook. Use Bun runtime for OpenTUI features.')
}

export const useKeyboard = () => {
  throw new Error('OpenTUI is not available in Storybook. Use Bun runtime for OpenTUI features.')
}

export const useOnResize = () => {
  throw new Error('OpenTUI is not available in Storybook. Use Bun runtime for OpenTUI features.')
}

// Type stubs
export type CliRenderer = unknown
export type CliRendererOptions = unknown
export type OpenTuiKeyEvent = unknown
export type OpenTuiRoot = unknown
