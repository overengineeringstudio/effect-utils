import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { Schema } from 'effect'

import { Decision, SignedPending, digest, type Pending } from '@overeng/scg-protocol'

const Card = Schema.Struct({
  record: SignedPending,
  channelId: Schema.String,
  messageId: Schema.String,
  controls: Schema.Array(Schema.Struct({ id: Schema.String, optionId: Schema.String })),
  inspectId: Schema.String,
  wordsId: Schema.String,
})
/** Signed pending record and opaque controls bound to one Discord message. */
export type Card = typeof Card.Type
const Job = Schema.Struct({ interactionId: Schema.String, card: Card, decision: Decision })
/** Durable decision outbox entry for an acknowledged interaction. */
export type Job = typeof Job.Type

/** Private signer state. A single process owns this DB; never share it with the authority. */
export class DiscordStore {
  readonly #db: Database
  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true })
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cards (execution_id TEXT PRIMARY KEY, json TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, signed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sync_cursor (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL);
      INSERT OR IGNORE INTO sync_cursor VALUES (1,0);`)
  }
  close(): void {
    this.#db.close()
  }
  add({
    record,
    channelId,
    messageId,
  }: {
    readonly record: SignedPending
    readonly channelId: string
    readonly messageId: string
  }): Card {
    const card: Card = {
      record,
      channelId,
      messageId,
      controls: record.payload.options
        .filter((offer) => offer.kind !== 'session-rule')
        .map(({ optionId }) => ({ id: randomUUID(), optionId })),
      inspectId: randomUUID(),
      wordsId: randomUUID(),
    }
    this.#db
      .query('INSERT INTO cards (execution_id,json) VALUES (?,?)')
      .run(record.payload.executionId, Schema.encodeSync(Schema.fromJsonString(Card))(card))
    return card
  }
  has(executionId: string): boolean {
    return (
      this.#db
        .query<{ execution_id: string }, [string]>(
          'SELECT execution_id FROM cards WHERE execution_id=?',
        )
        .get(executionId) !== null
    )
  }
  cards(): ReadonlyArray<Card> {
    return this.#db
      .query<{ json: string }, []>('SELECT json FROM cards WHERE closed=0')
      .all()
      .map(({ json }) => Schema.decodeSync(Schema.fromJsonString(Card))(json))
  }
  find({
    messageId,
    channelId,
  }: {
    readonly messageId: string
    readonly channelId: string
  }): Card | undefined {
    return this.cards().find((card) => card.messageId === messageId && card.channelId === channelId)
  }
  /** Atomic claim and outbox write: concurrent signed replays can produce at most one job. */
  claim({
    id,
    signedAt,
    job,
  }: {
    readonly id: string
    readonly signedAt: number
    readonly job?: Job | undefined
  }): boolean {
    return this.#db.transaction(() => {
      const result = this.#db
        .query('INSERT OR IGNORE INTO interactions VALUES (?,?)')
        .run(id, signedAt)
      if (result.changes !== 1) return false
      if (job !== undefined)
        this.#db
          .query('INSERT INTO jobs (id,json) VALUES (?,?)')
          .run(id, Schema.encodeSync(Schema.fromJsonString(Job))(job))
      return true
    })()
  }
  jobs(): ReadonlyArray<Job> {
    return this.#db
      .query<{ json: string }, []>('SELECT json FROM jobs WHERE acknowledged=1 ORDER BY rowid')
      .all()
      .map(({ json }) => Schema.decodeSync(Schema.fromJsonString(Job))(json))
  }
  acknowledged(interactionId: string): void {
    this.#db.query('UPDATE jobs SET acknowledged=1 WHERE id=?').run(interactionId)
  }
  discardUnacknowledged(): void {
    this.#db.query('DELETE FROM jobs WHERE acknowledged=0').run()
  }
  complete(interactionId: string): void {
    this.#db.query('DELETE FROM jobs WHERE id=?').run(interactionId)
  }
  closed(executionId: string): void {
    this.#db.query('UPDATE cards SET closed=1 WHERE execution_id=?').run(executionId)
  }
  prune(nowMs: number): void {
    this.#db
      .query('DELETE FROM interactions WHERE signed_at<? AND id NOT IN (SELECT id FROM jobs)')
      .run(nowMs - 300_000)
  }
  cursor(): number {
    return (
      this.#db.query<{ cursor: number }, []>('SELECT cursor FROM sync_cursor WHERE id=1').get()
        ?.cursor ?? 0
    )
  }
  advance(cursor: number): void {
    this.#db.query('UPDATE sync_cursor SET cursor=? WHERE id=1 AND cursor<=?').run(cursor, cursor)
  }
}

/** Binds a selected option and principal to the exact pending record shown on the card. */
export const decisionFor = ({
  card,
  optionId,
  principalId,
  surfaceId,
  decidedAt,
}: {
  readonly card: Card
  readonly optionId: Pending['options'][number]['optionId']
  readonly principalId: string
  readonly surfaceId: string
  readonly decidedAt: number
}): Decision => ({
  epoch: card.record.payload.epoch,
  kind: 'decision',
  executionId: card.record.payload.executionId,
  pendingDigest: digest(card.record.payload),
  optionId,
  surfaceId,
  principalId,
  decidedAt,
})
