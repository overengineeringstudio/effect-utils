/**
 * kit — the single import surface shared by the SSG explainers (build-time,
 * zero client runtime) and, later, the control dashboard (client React).
 *
 * CSS + engine are NOT re-exported here: they are authored artifacts inlined
 * verbatim by the SSG build (kit-components.css / kit-page.css / engine.js).
 */
export * from './components.tsx'
export * from './syncStory.ts'
export * from './fixtures.ts'
export * from './actors.ts'
