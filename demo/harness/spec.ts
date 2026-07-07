// Typed spec for a Notion-tooling demo, driven end-to-end by the harness.
//
// A demo is a `Demo` object with an ordered list of `Beat`s. Each beat performs
// one `Action` (drive the PTY, edit a local file, drive a Notion-side edit via
// the API, or wait), then the harness polls the beat's expectations until they
// pass (or a hard timeout). The Notion API is the *authoritative* assertion
// source; the terminal buffer and local files are secondary evidence.
//
// This file is types-only so demo specs (e.g. `demo/md/e2e.spec.ts`) and the
// runner can share it without importing runtime code.

/** Evidence surfaces captured per beat. */
export type Surface = 'notion' | 'terminal'

/** Result of a single expectation check. */
export interface Assertion {
  readonly ok: boolean
  /** Human-readable one-liner: what was checked and what was found. */
  readonly detail: string
}

/**
 * Runtime context handed to every async expectation / notion-edit closure.
 * Page ids are resolved fresh from the demo's `.demo-state/` after reset.
 */
export interface DemoCtx {
  /** Absolute path to the demo dir (e.g. `.../demo/md`). */
  readonly demoDir: string
  /** Absolute path to the stage dir the presenter `cd`s into. */
  readonly stageDir: string
  /** Absolute path to this run's evidence dir. */
  readonly evidenceDir: string
  /** role -> live Notion page id (e.g. `{ roadmap: '…', spec: '…' }`). */
  readonly pageIds: Readonly<Record<string, string>>
  /** role -> live Notion page url. */
  readonly pageUrls: Readonly<Record<string, string>>
  /** Notion API helpers (thin wrapper over `ntn api`). */
  readonly api: NotionApiLike
  /** Read the full watch log captured so far (raw, newline-delimited). */
  readonly readLog: () => string
}

/** The subset of the Notion API helper that specs are allowed to use. */
export interface NotionApiLike {
  /** GET `/v1/blocks/{id}/children` → parsed block list. */
  getBlocks: (blockId: string) => Promise<readonly NotionBlock[]>
  /** PATCH `/v1/blocks/{id}/children` — append children. */
  appendChildren: (blockId: string, children: readonly unknown[]) => Promise<void>
  /** PATCH `/v1/blocks/{id}` — update one block in place. */
  updateBlock: (blockId: string, body: Record<string, unknown>) => Promise<void>
  /** Find the first block whose plain-text matches `text` (exact). */
  findBlockByText: (
    blockId: string,
    text: string,
  ) => Promise<NotionBlock | undefined>
}

/** Minimal shape of a Notion block we care about for assertions. */
export interface NotionBlock {
  readonly id: string
  readonly type: string
  /** Concatenated `plain_text` of the block's rich_text, if any. */
  readonly text: string
  /** `checked` for `to_do` blocks, else undefined. */
  readonly checked?: boolean
  readonly raw: Record<string, unknown>
}

// --- Actions ---------------------------------------------------------------

/**
 * Type a command into the persistent demo shell (a real PTY) and press Enter.
 * Long-running commands (the watch daemon) stay in the foreground; the runner
 * tees stdout to the watch log for robust, scroll-safe assertion parsing.
 */
export interface PtyAction {
  readonly kind: 'pty'
  /** The command as the presenter would type it (e.g. `notion-md sync …`). */
  readonly cmd: string
  /** If true, the runner does NOT wait for the command to return (watch mode). */
  readonly background?: boolean
}

/** Send a control signal to the demo shell (e.g. Ctrl-C to stop the watcher). */
export interface PtySignalAction {
  readonly kind: 'pty-signal'
  /** pty key sequence, e.g. `ctrl+c`. */
  readonly key: string
}

/** Mutate a local stage file — the presenter's "edit + save". */
export interface EditAction {
  readonly kind: 'edit'
  /** File relative to the stage dir (e.g. `roadmap.nmd`). */
  readonly file: string
  /** Pure transform of the file's current text. */
  readonly apply: (text: string) => string
}

/**
 * Drive a Notion-side edit via the API — simulates "the presenter edits in the
 * browser". On camera this beat is a human editing the page; here we reproduce
 * the same remote mutation through `ctx.api` so the run is deterministic.
 */
export interface NotionEditAction {
  readonly kind: 'notion'
  readonly run: (ctx: DemoCtx) => Promise<void>
}

/** Pause — fixed delay or until a predicate holds. */
export interface WaitAction {
  readonly kind: 'wait'
  readonly ms?: number
  readonly until?: (ctx: DemoCtx) => Promise<boolean>
}

export type Action =
  | PtyAction
  | PtySignalAction
  | EditAction
  | NotionEditAction
  | WaitAction

// --- Beats & Demo ----------------------------------------------------------

/** A local-file expectation (beats 2 & 3 prove the *local* side of a sync). */
export interface FileExpectation {
  /** File relative to the stage dir. */
  readonly file: string
  /** Substring the file must (or must not) contain. */
  readonly contains: string
  /** If true, assert the substring is ABSENT (e.g. Notion was not clobbered). */
  readonly absent?: boolean
}

/**
 * DOM signal a Notion evidence screenshot must WAIT for before shooting — so the
 * frame captures the change the viewer should see (not a pre-update state). If
 * it never appears within the timeout the shot is marked `ui-not-reflected`
 * instead of shipping a wrong frame. Evidence-only; never an assertion.
 */
export type NotionReady =
  | { readonly kind: 'text'; readonly value: string } // page text contains value
  | { readonly kind: 'todoChecked'; readonly text: string } // to-do row is checked (strikethrough)

export interface Beat {
  readonly id: string
  /** What the presenter says on camera during this beat. */
  readonly narration: string
  readonly action: Action
  /**
   * Substring or regex the terminal must contain (this beat's log slice,
   * whitespace-normalized). Secondary evidence — not the source of truth.
   */
  readonly expectTerminal?: string | RegExp
  /** Authoritative assertion against the live Notion API. */
  readonly expectNotion?: (ctx: DemoCtx) => Promise<Assertion>
  /** Assertion against a local stage file. */
  readonly expectFile?: FileExpectation
  /** Evidence surfaces to screenshot this beat. */
  readonly screenshot?: readonly Surface[]
  /** Which page roles to capture when `screenshot` includes `notion` (default: all). */
  readonly capturePages?: readonly string[]
  /** DOM signal the Notion capture waits for before shooting (see `NotionReady`). */
  readonly notionReady?: NotionReady
  /** Soft time budget in seconds — warn when exceeded, never fail the run. */
  readonly budgetSec: number
}

/**
 * A page the demo binds. The live page id + url are read from the stage `.nmd`
 * file's frontmatter (the source of truth `notion-md` actually syncs against),
 * so they stay correct even if `.demo-state/` drifts.
 */
export interface DemoPage {
  readonly role: string
  /** Stage `.nmd` file, relative to the stage dir (e.g. `roadmap.nmd`). */
  readonly nmdFile: string
}

export interface Demo {
  readonly id: string
  readonly title: string
  /** Demo dir relative to repo root (e.g. `demo/md`). */
  readonly demoRel: string
  /** Stage dir relative to repo root (e.g. `demo/md/stage`). */
  readonly stageRel: string
  /** Reset script relative to repo root (e.g. `demo/md/reset.sh`). */
  readonly resetRel: string
  /** Watch-log filename, relative to the stage dir. */
  readonly watchLog: string
  readonly pages: readonly DemoPage[]
  readonly beats: readonly Beat[]
  /**
   * Optional PATH shim: `name` → absolute cli entrypoint. The runner writes an
   * executable wrapper so the on-screen command reads naturally (e.g. a
   * `notion-md` shim over `node …/dist/src/cli.js`).
   */
  readonly shims?: Readonly<Record<string, string>>
}
