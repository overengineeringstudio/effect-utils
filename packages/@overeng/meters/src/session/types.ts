/** Private frame-evidence capability shared with the frame source. */
export const frameState = Symbol('FrameClock.frameState')
/** Private capability evidence captured only when the platform is acquired. */
export const frameSupport = Symbol('FrameClock.frameSupport')
/** Private visibility seam used by scoped interval sources. */
export const visibility = Symbol('FrameClock.visibility')
/** Private 250ms summary cadence used for React-facing presentation publication. */
export const publication = Symbol('FrameClock.publication')
