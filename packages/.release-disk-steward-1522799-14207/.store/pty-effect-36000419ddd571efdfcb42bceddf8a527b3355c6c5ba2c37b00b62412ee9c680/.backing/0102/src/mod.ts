/**
 * `@overeng/pty-effect` — Effect-native wrapper around `@myobie/pty`.
 *
 * The root module wraps the `@myobie/pty/testing` surface for in-process
 * PTY testing. Use the `/client` subpath for detached daemon sessions,
 * session metadata/tags, stats, and event streaming.
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
  SessionStartEvent,
  SessionExitEvent,
  SessionRestartEvent,
  SessionFailedEvent,
  SupervisorStartEvent,
  SupervisorStopEvent,
  decodePtyEvent,
} from './PtyEvent.ts'
export type { PtySession } from './PtySession.ts'
export { make as makePtySession, defaultPollSchedule } from './PtySession.ts'
export { PtySpawner, layer, spawn } from './PtySpawner.ts'
