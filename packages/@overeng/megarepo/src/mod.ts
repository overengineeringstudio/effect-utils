/**
 * @module @overeng/megarepo
 *
 * Megarepo - A tool for composing multiple git repositories into a unified development environment.
 */

// Config schema
export * from './lib/config.ts'

// Services
export * from './lib/store.ts'

// Git utilities
export * from './lib/git.ts'
// Member mount lifecycle primitives
export * from './lib/member-mount.ts'
export * from './lib/member-mount-r6.ts'
export * from './lib/member-mount-cp-a-schema.ts'
export * from './lib/member-mount-cp-a.ts'

// Pure Buck composition-root projection
export * from './lib/generators/composition-root.ts'
