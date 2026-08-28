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
export * from './lib/dist-overlay-schema.ts'
export * from './lib/dist-overlay-lifecycle-schema.ts'
export * from './lib/dist-overlay-lifecycle.ts'

// Owned branch-worktree workspace lifecycle
export * from './lib/owned-worktree-acquisition-schema.ts'
export * from './lib/owned-worktree-acquisition.ts'

// Serialized workspace update lock and capability resolution
export * from './lib/workspace-update-lock-schema.ts'
export * from './lib/workspace-update-lock.ts'
export * from './lib/composition-capability-resolver-schema.ts'
export * from './lib/composition-capability-resolver.ts'
export * from './lib/composition-apply-schema.ts'
export * from './lib/composition-apply.ts'

// Pure Buck composition-root projection
export * from './lib/generators/composition-root.ts'
export * from './lib/generators/composition-root-publisher.ts'
