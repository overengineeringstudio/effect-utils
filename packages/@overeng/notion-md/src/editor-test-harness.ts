/**
 * Shared fake-gateway test harness for the editor write path. Extracted from the
 * `edit` e2e suite so `editor-edit.e2e.test.ts` and `progress.unit.test.ts` drive
 * the engine through one fake instead of duplicating ~100 lines. Lives in a
 * non-`.test.ts` module so vitest does not collect it as a suite.
 */
import { Effect, FileSystem, Layer } from 'effect'

import type { BodyCompleteness } from '@overeng/notion-core'

import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'

/** Canonical page id used across the editor harness tests. */
export const harnessPageId = '00000000-0000-4000-8000-000000000001'

/** Mutable remote state the fake gateway reflects. */
export interface FakeState {
  title: string
  body: string
  completeness: BodyCompleteness
}

/** Build a remote page snapshot from the fake state. */
export const snapshot = (s: FakeState): RemotePageSnapshot => ({
  id: harnessPageId,
  title: s.title,
  title_property_key: 'title',
  url: 'https://notion.so/page',
  parent: { type: 'workspace', workspace: true },
  icon: null,
  cover: null,
  in_trash: false,
  is_locked: false,
  last_edited_time: '2026-06-15T12:00:00.000Z',
  properties: {},
})

/** Build a pull result from the fake state. */
export const pull = (s: FakeState): PullPageResult => ({
  page: snapshot(s),
  markdown: {
    markdown: normalizeMarkdownLineEndings(s.body),
    truncated: false,
    unknown_block_ids: [],
    completeness: s.completeness,
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
})

/**
 * In-memory Notion gateway for editor write-path tests: reflects pulls/writes
 * against mutable `state`, can simulate a concurrent remote writer
 * (`switchRemoteBodyAfter`), and can fail the next `updateMarkdown`
 * (`failUpdateMarkdownOnce`) to exercise the write-body error path.
 */
export class FakeGateway {
  readonly state: FakeState
  /** When set, the remote body switches to `body` after `afterPull` pulls. */
  private switchBodyOnPull: { afterPull: number; body: string } | undefined
  /** When set, the next `updateMarkdown` fails with this gateway error. */
  private failUpdateMarkdown: NmdGatewayError | undefined
  pullCount = 0
  constructor(initial: { title: string; body: string; completeness?: BodyCompleteness }) {
    this.state = {
      title: initial.title,
      body: normalizeMarkdownLineEndings(initial.body),
      completeness: initial.completeness ?? { _tag: 'complete' },
    }
  }

  /** Simulate a concurrent remote writer: after `afterPull` pulls, body becomes `body`. */
  // oxlint-disable-next-line overeng/named-args -- test fixture preserving the original e2e harness shape
  switchRemoteBodyAfter(afterPull: number, body: string): void {
    this.switchBodyOnPull = { afterPull, body: normalizeMarkdownLineEndings(body) }
  }

  /** Make the next `updateMarkdown` (the body write) fail once, to test the failure stage. */
  failUpdateMarkdownOnce(operation = 'fake_update_markdown'): void {
    this.failUpdateMarkdown = new NmdGatewayError({
      operation,
      page_id: harnessPageId,
      message: 'simulated updateMarkdown failure',
    })
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: () =>
      Effect.sync(() => {
        this.pullCount += 1
        if (
          this.switchBodyOnPull !== undefined &&
          this.pullCount > this.switchBodyOnPull.afterPull
        ) {
          this.state.body = this.switchBodyOnPull.body
          this.switchBodyOnPull = undefined
        }
        return pull(this.state)
      }),
    updateMarkdown: ({ command }) =>
      Effect.suspend(() => {
        if (this.failUpdateMarkdown !== undefined) {
          const error = this.failUpdateMarkdown
          this.failUpdateMarkdown = undefined
          return Effect.fail(error)
        }
        if (command._tag === 'replace_content') {
          this.state.body = normalizeMarkdownLineEndings(command.markdown)
        }
        return Effect.succeed({ markdown: pull(this.state).markdown })
      }),
    updatePageProperties: () => Effect.die(new Error('unexpected updatePageProperties')),
    retrieveDataSource: () => Effect.die(new Error('unexpected retrieveDataSource')),
    updatePageMetadata: ({ metadata }) =>
      Effect.sync(() => {
        if (metadata.title !== undefined) this.state.title = metadata.title.value
        return snapshot(this.state)
      }),
    listChildPages: () => Effect.succeed([]),
    createPage: () => Effect.die(new Error('unexpected createPage')),
    movePage: () => Effect.die(new Error('unexpected movePage')),
    archivePage: () => Effect.die(new Error('unexpected archivePage')),
  } satisfies NotionMdGatewayShape)
}

/* oxlint-disable overeng/named-args -- test fixtures preserve the original positional e2e harness shape */

/** A scripted non-interactive editor: rewrite the buffer file via a transform. */
export const scriptedEditor =
  (transform: (buffer: string) => string, exitCode = 0) =>
  (opts: {
    readonly filePath: string
  }): Effect.Effect<number, NmdGatewayError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (exitCode === 0) {
        const buffer = yield* fs.readFileString(opts.filePath)
        yield* fs.writeFileString(opts.filePath, transform(buffer))
      }
      return exitCode
    }).pipe(
      Effect.mapError(
        (cause) =>
          new NmdGatewayError({ operation: 'scripted_editor', message: String(cause), cause }),
      ),
    )
