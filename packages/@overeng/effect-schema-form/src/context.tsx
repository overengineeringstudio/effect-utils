import { createContext, type ReactNode, useContext } from 'react'

import type { FieldRenderers } from './types.ts'

/** Context value for SchemaForm renderer configuration */
export interface SchemaFormContextValue {
  /** Renderers for each field type */
  renderers: FieldRenderers
}

/** Context for providing field renderers to SchemaForm components */
export const SchemaFormContext = createContext<SchemaFormContextValue | null>(null)

/** Props for SchemaFormProvider */
export interface SchemaFormProviderProps {
  /** Renderers for each field type */
  renderers: FieldRenderers
  /** Child components */
  children: ReactNode
}

/**
 * Provider for configuring SchemaForm field renderers.
 *
 * Use this to provide custom renderers for a tree of SchemaForm components:
 *
 * ```tsx
 * <SchemaFormProvider renderers={myRenderers}>
 *   <SchemaForm schema={MySchema} value={data} onChange={setData} />
 * </SchemaFormProvider>
 * ```
 */
export const SchemaFormProvider = ({ renderers, children }: SchemaFormProviderProps): ReactNode => (
  <SchemaFormContext.Provider value={{ renderers }}>{children}</SchemaFormContext.Provider>
)

/**
 * Hook to access the current SchemaForm context.
 * Returns null if not within a SchemaFormProvider.
 */
export const useSchemaFormContext = (): SchemaFormContextValue | null =>
  useContext(SchemaFormContext)
