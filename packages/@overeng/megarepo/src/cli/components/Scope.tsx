/** Scope context for spotlight rendering — in-scope items render normally, out-of-scope items are dimmed. */

import { createContext, useContext, useMemo, type ReactNode } from 'react'

interface ScopeState {
  /** Whether the current item is in the active scope. Default: true (no dimming). */
  readonly inScope: boolean
}

const ScopeContext = createContext<ScopeState>({ inScope: true })

/** Wraps children with scope state — items outside scope are dimmed by MemberRow. */
export const ScopeProvider = ({ inScope, children }: { inScope: boolean; children: ReactNode }) => {
  const value = useMemo(() => ({ inScope }), [inScope])
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

/** Reads the current scope state (defaults to in-scope when no provider is present). */
export const useScope = (): ScopeState => useContext(ScopeContext)
