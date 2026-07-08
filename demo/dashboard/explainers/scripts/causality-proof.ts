#!/usr/bin/env bun
/**
 * causality-proof.ts — proves the build-failing causal assertion works both ways:
 *   1. the REAL sqlite story constructs cleanly (cause before effect)
 *   2. a deliberately-INVERTED story (remote effect before the sync) THROWS
 *      `CausalityError` — i.e. it would fail the build
 *
 * Run: `bun run scripts/causality-proof.ts`. Exits non-zero if either
 * expectation is violated.
 */
import { CausalityError, captionsToSteps, syncStory } from '../../kit/syncStory.ts'
import { sqliteStory } from '../src/sqlite.tsx'

let ok = true

// (1) the real story must construct (importing it already ran the assert).
if (sqliteStory.steps.length === 4) {
  console.log('✓ real sqlite story constructs (cause before effect holds)')
} else {
  console.error('✗ real sqlite story unexpected shape')
  ok = false
}

const expectThrow = (label: string, build: () => unknown) => {
  try {
    build()
    console.error(`✗ ${label}: did NOT throw — the build guard is broken`)
    ok = false
  } catch (e) {
    if (e instanceof CausalityError) console.log(`✓ ${label} throws CausalityError`)
    else {
      console.error(`✗ ${label}: wrong error: ${String(e)}`)
      ok = false
    }
  }
}

// (2) STEP-GRANULAR inversion: remote effect at an EARLIER step than the sync.
expectThrow('step-granular inversion (remote step 2 < sync step 3)', () =>
  syncStory({
    steps: captionsToSteps(['idle', 'edit', 'sync', 'settled']),
    local: { pane: 'db', swap: { was: 'In Progress', now: 'Done', at: { step: 2 } } },
    sync: { step: 3, duration: 1450 },
    remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 2 } } }, // BUG
  }),
)

// (3) THE KEY INTRA-STEP CASE — the dominant bug the review catalogued:
// effect assigned to the CORRECT step but painted at t=0 while its cause (the
// packet) is still in flight. A step-granular assert (remote.step == sync.step)
// would MISS this; the reveal-TIME assert catches it.
expectThrow('intra-step effect-before-arrival (remote +700ms < packet arrival +1450ms)', () =>
  syncStory({
    steps: captionsToSteps(['idle', 'edit', 'sync', 'settled']),
    sync: { step: 3, duration: 1450 }, // packet departs step-3 entry, arrives +1450ms
    // BUG: remote flips at +700ms — right step, but WHILE the packet is still crossing.
    remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 3, delay: 700 } } },
  }),
)

// (4) single-step story with NO distinct local pane (the codegen/iac shape):
// action + effect share ONE step; a t=0 effect (code materializes at step entry,
// before the read packet resolves) must still throw.
expectThrow('single-step effect at entry (codegen/iac shape, no gate)', () =>
  syncStory({
    steps: captionsToSteps(['point at DB', 'generate', 'autocomplete', 'CI drift']),
    sync: { step: 2, duration: 1400 }, // `generate` reads the DB over ~1.4s
    // BUG: generated code + `✓ wrote` reveal at step-2 entry, before the read completes.
    remote: { pane: 'ide', swap: { was: '(empty)', now: 'schema.gen.ts', at: { step: 2, delay: 0 } } },
  }),
)

// (5) POSITIVE control: the same single-step shape, correctly gated to arrival, PASSES.
try {
  const codegenLike = syncStory({
    steps: captionsToSteps(['point at DB', 'generate', 'autocomplete', 'CI drift']),
    sync: { step: 2, duration: 1400 },
    remote: { pane: 'ide', swap: { was: '(empty)', now: 'schema.gen.ts', at: { step: 2, delay: 1400 } } },
  })
  console.log(`✓ single-step gated-to-arrival story constructs (arrival = step ${codegenLike.arrival.step} +${codegenLike.arrival.delay}ms)`)
} catch (e) {
  console.error(`✗ correctly-gated single-step story wrongly threw: ${String(e)}`)
  ok = false
}

process.exit(ok ? 0 : 1)
