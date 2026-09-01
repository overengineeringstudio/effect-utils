/**
 * Values shared between the browser-side annotations and the Node-side runner.
 *
 * Its own module because it has no imports: the annotations pull in
 * `vitest/browser`, which throws outside Browser Mode, and the runner pulls in
 * `node:child_process`. Neither can import the other.
 *
 * @module
 */

/** Marker the runner greps out of a run's output to report opted-out stories. */
export const excludedStoryMarker = '[story-gate] excluded '
