/**
 * `@overeng/pty-effect` — Effect-native wrapper around `@myobie/pty`.
 *
 * v0 wraps the `@myobie/pty/testing` `Session` API (the only subpath
 * actually exported by upstream 0.4.1). This covers spawn-mode and
 * server-mode pty sessions, multi-client attach/reattach, screenshots,
 * resize, and Schedule-driven `waitFor*` predicates.
 *
 * Future scope: when upstream re-exports `SessionConnection`, `spawnDaemon`,
 * and `EventFollower` via its package `exports` map, a `/client` subpath
 * will materialize the schemas already defined in `PtyEvent.ts`.
 *
 * Tracking upstream:
 * - https://github.com/myobie/pty/issues/6 (`/client` subpath exports)
 * - https://github.com/myobie/pty/issues/7 (`EventFollower` shipping)
 */
export { PtyError } from './PtyError.ts'
export { Key, NamedKey, key } from './PtyKey.ts'
export { PtyName, PtySpec, PtySpawnSpec, PtyServerSpec, PtySpec_, TerminalSize } from './PtySpec.ts'
export { Screenshot } from './Screenshot.ts'
export {
  PtyEvent,
  BellEvent,
  TitleChangeEvent,
  NotificationEvent,
  FocusRequestEvent,
  CursorVisibleEvent,
} from './PtyEvent.ts'
export type { PtySession } from './PtySession.ts'
export { make as makePtySession, defaultPollSchedule } from './PtySession.ts'
export { PtySpawner, layer, spawn } from './PtySpawner.ts'
