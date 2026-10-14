/** Session-private publication of lifecycle revisions without manufacturing observations. */
export const publishRevision = Symbol('SeriesStore.publishRevision')
/** Session-owned UI publication, independent of acquisition revisions. */
export const subscribePresentation = Symbol('SeriesStore.subscribePresentation')
