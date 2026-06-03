import { Schema } from 'effect'

import { pageSurfaceKey } from '../core/canonical.ts'
import type { PageId } from '../core/domain.ts'
import {
  SurfaceKey,
  SyncEvent,
  type SyncEvent as SyncEventType,
  type SyncRootId,
} from '../core/events.ts'
import { readUserActionSurface, type UserCommandPlan } from '../core/result-envelope.ts'
import { readOneShotSyncStatus } from '../core/status.ts'
import { hashStoreBytes } from '../store/projections.ts'
import type { NotionSyncStore } from '../store/store.ts'
export { resolveConflictCommand, restorePageCommand } from './conflict-commands.ts'
export type { ConflictResolutionChoice } from './conflict-commands.ts'
export type {
  PlannedGuard,
  UserActionSurface,
  UserCommandPlan,
  UserCommandResultEnvelope,
} from '../core/result-envelope.ts'

type UserActionOptions = {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dryRun?: boolean
  readonly now?: () => Date
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const eventIdPart = (value: string): string => value.replaceAll(':', '-').replaceAll('/', '-')

const eventPayload = (value: unknown): SyncEventType['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson: JSON.stringify(value),
})

const emptyPlan = (): UserCommandPlan => ({ events: [], commands: [], guards: [] })

const resultEnvelope = <TAction extends string>({
  action,
  rootId,
  store,
  dryRun,
  planned,
  applied,
}: UserActionOptions & {
  readonly action: TAction
  readonly dryRun: boolean
  readonly planned: UserCommandPlan
  readonly applied: UserCommandPlan
}) => ({
  _tag: 'UserCommandResultEnvelope' as const,
  version: 'v1' as const,
  action,
  rootId,
  dryRun,
  status: readOneShotSyncStatus({ store, rootId }),
  surface: readUserActionSurface({ store, rootId }),
  planned,
  applied,
})

const makeRowForgottenEvent = ({
  rootId,
  pageId,
  now,
}: {
  readonly rootId: SyncRootId
  readonly pageId: PageId
  readonly now: () => Date
}): SyncEventType =>
  decode({
    schema: SyncEvent,
    value: {
      _tag: 'RowForgotten',
      eventId: `forget:${eventIdPart(pageId)}:${eventIdPart(now().toISOString())}`,
      rootId,
      sequence: '0',
      codecVersion: 'v1',
      family: 'LocalIntentAccepted',
      eventType: 'RowForgotten',
      idempotencyKey: `forget:${pageId}:${eventIdPart(now().toISOString())}`,
      surface: decode({ schema: SurfaceKey, value: pageSurfaceKey(pageId) }),
      causedByEventIds: [],
      payloadHash: hashStoreBytes('placeholder'),
      payload: eventPayload({ pageId, reason: 'user-forget' }),
      observedAt: now().toISOString(),
      pageId,
      reason: 'user-forget',
    },
  })

/** Return a `UserCommandResultEnvelope` describing the current sync surface without planning or applying any changes — useful for CLI list/status commands. */
export const listUserCommandSurface = (options: UserActionOptions) =>
  resultEnvelope({
    ...options,
    action: 'list',
    dryRun: options.dryRun === true,
    planned: emptyPlan(),
    applied: emptyPlan(),
  })

/** Emit a `RowForgotten` event to remove a page from the local sync projection without touching the remote; useful for evicting orphaned or stale rows. Respects `dryRun`. */
export const forgetPageCommand = (
  options: UserActionOptions & {
    readonly pageId: PageId
  },
) => {
  const now = options.now ?? (() => new Date())
  const dryRun = options.dryRun === true
  const planned: UserCommandPlan = {
    events: [makeRowForgottenEvent({ rootId: options.rootId, pageId: options.pageId, now })],
    commands: [],
    guards: [],
  }
  const applied =
    dryRun === true
      ? emptyPlan()
      : {
          events: planned.events.flatMap((event) => {
            const result = options.store.appendEventWithResult(event)
            return result.inserted === true ? [result.event] : []
          }),
          commands: [],
          guards: [],
        }

  return resultEnvelope({
    ...options,
    action: 'forget-page',
    dryRun,
    planned,
    applied,
  })
}
