/** Session-private publication of lifecycle revisions without manufacturing observations. */
export const publishRevision = Symbol('SeriesStore.publishRevision')
/** Session-owned UI publication, independent of acquisition revisions. */
export const subscribePresentation = Symbol('SeriesStore.subscribePresentation')

/** Deliver every committed-observation notification before surfacing defects. */
export const notifyListeners = (subscribers: ReadonlySet<() => void>): void => {
  let faults: unknown[] | undefined
  for (const notify of subscribers) {
    try {
      notify()
    } catch (cause) {
      ;(faults ??= []).push(cause)
    }
  }
  if (faults !== undefined) throw new AggregateError(faults, 'Series subscriber failed')
}
