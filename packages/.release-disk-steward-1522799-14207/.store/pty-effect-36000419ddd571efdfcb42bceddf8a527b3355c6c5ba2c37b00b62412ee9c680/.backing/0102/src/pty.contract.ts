/**
 * SEAM member contract for the `pty.*` telemetry namespace (decision 0005) — pty-effect's OWN
 * observability catalog, authored via the Layer-2 `@overeng/otel-contract/registry` surface. This
 * is the single home for the `pty.*` telemetry catalog + signals: the Weaver registry projection
 * AND the runtime encoders (`src/PtySession.ts`, `src/client.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (pty-effect has no dependency-free zone; both `PtySession.ts` and `client.ts`
 * already import `@overeng/otel-contract` at runtime, so this file's `./registry` import is
 * runtime-safe here).
 *
 * SCOPE — `pty` namespace only. All keys are already namespaced `pty.*` (NO bare-key renames).
 *
 * ONE STATIC SIGNAL. `pty-session.make` is a single static-name span carrying `pty.session.mode`;
 * it projects as a registered `span` signal.
 *
 * DYNAMIC-NAME BRIDGES (SC-DQ5). The `client.ts` per-method spans are emitted through a
 * `spanName`-parameterized `OtelOperation.define` FACTORY (`withPtyNameSpan` / `withPtyWaitSpan`,
 * applied to `pty-client.spawnDaemon`, `pty-client.peek`, `pty-client.waitForText`, … — a family of
 * span names sharing two attribute shapes). Because the span name is not fixed per contract entry,
 * these have no stable single-signal projection and stay LEGACY inline in `client.ts`, rebuilt from
 * the IMPORTED catalog schemas below (identical encode — proven by the colocated equivalence test).
 * Their `pty.name` / `pty.wait.needle` keys reach the catalog via `docOnlyAttributes` (SC-R13). The
 * third `client.ts` shape (`withPtyOperationSpan`, label-only: `pty-client.list`/`gc`/`followEvents`)
 * carries NO catalog attribute, so it contributes no key and stays inline untouched.
 */
import { Schema } from 'effect'

import { OtelAttr } from '@overeng/otel-contract'
import { attr, defineOtelContract, operation, required } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the pty.* catalog SSOT)
// ---------------------------------------------------------------------------

/** How a pty session was created (in-process spawn vs. detached server). */
export const PtySessionMode = attr.enum({
  key: 'pty.session.mode',
  values: ['Spawn', 'Server'],
  briefs: {
    Spawn: 'In-process spawn (scope-bound, kill-on-close).',
    Server: 'Detached daemon/server session.',
  },
  brief: 'How a pty session was created (in-process spawn vs. detached server).',
  stability: 'development',
})

/** Name of the pty session a client operation targets. */
export const PtyName = attr.string({
  key: 'pty.name',
  cardinality: 'high',
  brief: 'Name of the pty session a client operation targets.',
  stability: 'development',
  examples: ['dev-server', 'build'],
})

/** Needle a `waitFor*` client operation polls the terminal for. */
export const PtyWaitNeedle = attr.string({
  key: 'pty.wait.needle',
  cardinality: 'high',
  brief: 'Needle a waitFor* client operation polls the terminal for.',
  stability: 'development',
  examples: ['Server listening', 'Compiled successfully'],
})

// ---------------------------------------------------------------------------
// signals (operations: static-name span; label derived from a runtime-only field)
// ---------------------------------------------------------------------------

/** The runtime-only span-label source field (dropped from attribute output; SC-T03). */
const labelField = { label: OtelAttr.drop(Schema.NonEmptyString) } as const
const labelOf = (v: { label: string }): string => v.label

/** `pty-session.make` — construction of a pty session (Spawn or Server). */
export const PtySessionMakeOperation = operation({
  id: 'span.pty.session_make',
  name: 'pty-session.make',
  brief: 'Construction of a pty session (Spawn or Server).',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    mode: required(PtySessionMode),
  },
  labelFields: labelField,
  label: labelOf,
})

// ---------------------------------------------------------------------------
// contract seam (namespace `pty`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/pty-effect',
  displayName: 'Pty Attributes',
  signals: [PtySessionMakeOperation],
  // Keys reaching the catalog ONLY via the dynamic-name client bridges (`withPtyNameSpan` /
  // `withPtyWaitSpan` in `client.ts`), rebuilt inline from the SAME schemas. Catalog completeness
  // (SC-R13).
  docOnlyAttributes: [PtyName, PtyWaitNeedle],
})
