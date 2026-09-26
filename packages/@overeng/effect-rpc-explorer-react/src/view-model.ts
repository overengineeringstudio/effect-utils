import type { RecordState, RequestIdentity, RpcDescriptorWire } from '@overeng/effect-rpc-explorer'

/** Semantic presentation tone for one lifecycle status. */
export type StatusTone = 'success' | 'failure' | 'warning' | 'fault' | 'info'

/** Visible labels, symbols, and tones for every retained lifecycle state. */
export const statusByState: Record<
  RecordState,
  {
    readonly label: string
    readonly compactLabel?: string
    readonly symbol: string
    readonly tone: StatusTone
  }
> = {
  sending: { label: 'Sending', symbol: '→', tone: 'info' },
  sent: { label: 'Sent', symbol: '→', tone: 'info' },
  awaiting: { label: 'Awaiting', symbol: '…', tone: 'info' },
  streaming: { label: 'Streaming', symbol: '⇢', tone: 'info' },
  cancellationRequested: {
    label: 'Cancellation requested',
    compactLabel: 'Cancel req.',
    symbol: '!',
    tone: 'warning',
  },
  sendFailed: { label: 'Send failed', symbol: '×', tone: 'failure' },
  succeeded: { label: 'Succeeded', symbol: '✓', tone: 'success' },
  failed: { label: 'Typed failure', symbol: '×', tone: 'failure' },
  defect: { label: 'Defect', symbol: '◆', tone: 'fault' },
  interrupted: { label: 'Interrupted', symbol: '■', tone: 'warning' },
  uncertain: { label: 'Uncertain', symbol: '?', tone: 'fault' },
  notificationSent: {
    label: 'Notification sent',
    compactLabel: 'Notified',
    symbol: '✓',
    tone: 'success',
  },
}

/** States whose elapsed duration continues through the current clock sample. */
export const activeStates: ReadonlySet<RecordState> = new Set([
  'sending',
  'sent',
  'awaiting',
  'streaming',
  'cancellationRequested',
])

/** Formats a non-negative diagnostic duration at compact list density. */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

/** Formats the complete typed request identity without collapsing its tag. */
export const identityText = (key: RequestIdentity): string =>
  `${key.observerSide} · ${key.connectionId} · ${key.direction} · ${key.requestId._tag.toLowerCase()}:${String(key.requestId.value)}`

/** Returns a human-readable descriptor identity with an explicit unknown fallback. */
export const descriptorName = (descriptor: RpcDescriptorWire | undefined): string => {
  if (descriptor === undefined) return 'Unknown descriptor'
  return descriptor.tag === '' || descriptor.tag === descriptor.key
    ? descriptor.key
    : `${descriptor.key} · ${descriptor.tag}`
}
