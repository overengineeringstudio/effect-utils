import { Context, Effect, Layer, Option } from 'effect'

/**
 * Stable, CLI-facing stage vocabulary for a write-path sync (R43). These ids are
 * a presentation contract distinct from the OTEL span names (which stay on the
 * `notion_md.*` namespace, decision 0018); a stage may map to several spans or
 * none.
 */
export type ProgressStageId = 'observe' | 'write-body' | 'write-title' | 'settle'

/** A single staged transition the engine emits to the reporter. */
export interface ProgressStage {
  readonly id: ProgressStageId
  readonly label: string
  readonly message?: string
}

/**
 * The render seam (R45): the engine emits purpose-tagged stage transitions; the
 * provided Layer decides whether/how to render. Every method returns
 * `Effect.Effect<void>` so a renderer can do I/O, and the no-op/absent Layer
 * makes the whole surface zero-cost and behavior-neutral.
 */
export interface ProgressReporterShape {
  readonly stageActive: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageSucceed: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageSkip: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageFail: (stage: ProgressStage) => Effect.Effect<void>
  /** Free-form stderr note for the "+ warn" outcomes (drift auto-merge / conflict). */
  readonly note: (message: string) => Effect.Effect<void>
}

/** Render seam for staged write-path sync progress (decision 0018, R43–R45). */
export class ProgressReporter extends Context.Tag('ProgressReporter')<
  ProgressReporter,
  ProgressReporterShape
>() {}

/**
 * Emit a reporter call without adding to the engine's `R`, and swallowing ALL
 * failures and defects (R45): a render glitch can never change a result or exit
 * code. `Effect.serviceOption` requires nothing in `R` (returns
 * `Option<Service>`), so the engine stays render-agnostic; when no Layer is
 * provided the emit is a silent no-op.
 */
const emit = (f: (r: ProgressReporterShape) => Effect.Effect<void>): Effect.Effect<void> =>
  Effect.serviceOption(ProgressReporter).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: f })),
    Effect.catchAllCause(() => Effect.void),
  )

/** Emit an `active` transition for a stage. */
export const reportStageActive = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageActive(stage))

/** Emit a `succeed` transition for a stage. */
export const reportStageSucceed = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageSucceed(stage))

/** Emit a `skip` transition for a stage (a no-op step the user should still see). */
export const reportStageSkip = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageSkip(stage))

/** Emit a `fail` transition for a stage. */
export const reportStageFail = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageFail(stage))

/** Emit a free-form stderr note (the drift auto-merge / conflict warnings). */
export const reportNote = (message: string): Effect.Effect<void> => emit((r) => r.note(message))

/**
 * Wrap an effect as a single stage: emit `active` before it runs, `succeed`
 * (with the optional done message) on success, and `fail` on error. Preserves
 * the wrapped effect's `A`/`E`/`R` exactly — the emit helpers are
 * `Effect<void, never, never>`, so the engine's signatures do not change.
 */
// oxlint-disable-next-line overeng/named-args -- data-last Effect combinator (stage config + wrapped effect)
export const withStage = <A, E, R>(
  stage: { readonly id: ProgressStageId; readonly label: string; readonly doneMessage?: string },
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  reportStageActive(stage).pipe(
    Effect.zipRight(eff),
    Effect.tap(() =>
      reportStageSucceed(
        stage.doneMessage === undefined ? stage : { ...stage, message: stage.doneMessage },
      ),
    ),
    Effect.tapErrorCause(() => reportStageFail(stage)),
  )

/**
 * Explicit no-op Layer for tests/clarity. (Absence of a Layer already no-ops via
 * `serviceOption`; this just makes the intent provable.)
 *
 * The live renderer Layer now lives at the CLI boundary: `cli-output/edit` bridges
 * the `ProgressReporter` seam onto the tui-react OutputMode app (Slice B),
 * replacing the previous stderr-line Layer that lived here.
 */
export const ProgressReporterNoop: Layer.Layer<ProgressReporter> = Layer.succeed(ProgressReporter, {
  stageActive: () => Effect.void,
  stageSucceed: () => Effect.void,
  stageSkip: () => Effect.void,
  stageFail: () => Effect.void,
  note: () => Effect.void,
} satisfies ProgressReporterShape)
