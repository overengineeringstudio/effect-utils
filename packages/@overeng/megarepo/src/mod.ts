/**
 * @module @overeng/megarepo
 *
 * Megarepo - A tool for composing multiple git repositories into a unified development environment.
 */

// Config schema
export * from './core/config.ts'

// Services
export * from './store/store.ts'
// Readonly pool observations, never cleanup authority.
export { PoolProvenanceUnavailableError, type PoolRootProvenance, readPoolProvenance } from './store/store-pool-provenance.ts'

// Git utilities
export * from './core/git.ts'
// Member mount inspection
export * from './sync/member-mount.ts'
