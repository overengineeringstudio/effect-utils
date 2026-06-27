/**
 * Pure dev-warning helpers for genie's isomorphic (`.`) builders.
 *
 * Builders occasionally emit a dev warning at build time. Referencing the ambient `console` global directly
 * would force a typechecking consumer of the `.` entry to add the DOM/node lib (where `console` is declared),
 * defeating the entry's purity. A module-scoped `declare const console` makes the reference resolvable without
 * any lib (it is erased at emit and backed by the real runtime `console`, always present in node and the genie
 * engine), so the `.` closure stays free of DOM/node ambient globals.
 */
declare const console: {
  readonly warn: (...args: readonly unknown[]) => void
  readonly error: (...args: readonly unknown[]) => void
}

/** Emit a dev warning (backed by the runtime `console.warn`). */
export const warn = (message: string): void => console.warn(message)

/** Emit a dev error log (backed by the runtime `console.error`). */
export const error = (message: string): void => console.error(message)
