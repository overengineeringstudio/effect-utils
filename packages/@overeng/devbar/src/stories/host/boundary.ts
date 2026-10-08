/** Host-owned options; this boundary imports no diagnostic runtime code eagerly. */
export interface HostDiagnosticsOptions {
  readonly node: HTMLElement
  readonly dark: boolean
  readonly storageKey: string
  readonly signal: AbortSignal
}

// Storybook opts into an explicit diagnostic build; ordinary production does not.
const loadDiagnostics =
  import.meta.env.DEV === true || import.meta.env.VITE_HOST_DIAGNOSTICS === 'true'
    ? () => import('./devtools.tsx')
    : undefined
/** The host checks its preference before loading or acquiring any diagnostics. */
export const startHostDiagnostics = async (
  options: HostDiagnosticsOptions & { readonly enabled: boolean },
): Promise<(() => Promise<void>) | undefined> => {
  if (
    loadDiagnostics === undefined ||
    options.enabled === false ||
    Boolean(options.signal.aborted) === true
  )
    return undefined
  const { mountDiagnostics } = await loadDiagnostics()
  if (options.signal.aborted === true) return undefined
  return mountDiagnostics(options)
}

/** Storage is best-effort host policy, never a responsibility of the shell. */
export const readHostPreference = (key: string): boolean => {
  if (import.meta.env.DEV === false && import.meta.env.VITE_HOST_DIAGNOSTICS !== 'true')
    return false
  try {
    return localStorage.getItem(key) !== 'false'
  } catch {
    return true
  }
}
