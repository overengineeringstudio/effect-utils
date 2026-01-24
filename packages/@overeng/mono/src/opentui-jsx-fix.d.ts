/**
 * Module augmentation to fix JSX `key` prop type error with pnpm's enableGlobalVirtualStore.
 *
 * When using enableGlobalVirtualStore, packages are symlinked to the global pnpm store.
 * The @opentui/react package's JSX types extend React.Attributes, but TypeScript can't
 * resolve @types/react from within the global store path. This causes `key` to be missing
 * from IntrinsicAttributes.
 *
 * This augmentation adds the `key` prop directly to @opentui/react's JSX namespace.
 *
 * TODO(bun-migration): Remove this file once we switch back to bun.
 * See: context/workarounds/pnpm-issues.md (PNPM-03)
 */
import type { Key } from 'react'

declare module '@opentui/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicAttributes {
      key?: Key | null | undefined
    }
  }
}
