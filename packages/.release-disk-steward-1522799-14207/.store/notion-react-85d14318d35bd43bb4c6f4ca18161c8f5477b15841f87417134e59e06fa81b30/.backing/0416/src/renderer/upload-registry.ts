import { createContext, useContext, useMemo } from 'react'

/**
 * Registry of pre-resolved uploads keyed by a content hash.
 *
 * When a component mounts inside an `UploadRegistry.Provider`, it can look
 * up a previously resolved upload by hash. When there is no provider,
 * `useNotionUpload` falls back to calling the factory eagerly; this assumes
 * the caller pre-resolves uploads before rendering (v0.1 policy).
 *
 * Suspense-backed lazy resolution is v0.2 and intentionally omitted here.
 */
export type UploadRecord = {
  readonly hash: string
  readonly url: string
  readonly fileId?: string
}

export type UploadRegistry = {
  readonly get: (hash: string) => UploadRecord | undefined
}

const UploadRegistryContext = createContext<UploadRegistry | null>(null)

export const UploadRegistryProvider = UploadRegistryContext.Provider

/**
 * Resolve an upload from the registry if present, otherwise synchronously
 * return the result of `factory()`. Callers that rely on async uploads
 * must pre-populate a registry via `UploadRegistryProvider`.
 */
export const useNotionUpload = (hash: string, factory: () => UploadRecord): UploadRecord => {
  const registry = useContext(UploadRegistryContext)
  return useMemo(() => registry?.get(hash) ?? factory(), [registry, hash, factory])
}
