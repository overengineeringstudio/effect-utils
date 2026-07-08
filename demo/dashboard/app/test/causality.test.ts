/**
 * causality.test.ts — the causal guarantee, enforced by vitest.
 *
 * Ported from the (deleted) SSG-era `explainers/scripts/causality-proof.ts`. The
 * cause-before-effect assert lives in the syncStory/multiSyncStory CONSTRUCTOR
 * (kit/syncStory.ts) and used to be enforced "at build" because the SSG imported
 * every story. With the SSG gone, THIS test is the choke point: an explainer whose
 * effect (a remote pane repaint) is painted before its cause (the sync packet
 * arrives) throws `CausalityError` at construction — so an inversion cannot ship.
 *
 * Run: `bun run test` (in demo/dashboard/app) or `vitest run`.
 *
 * Positive cases: importing the real explainers already runs each story's assert;
 * we additionally sanity-check their derived shapes. Negative cases: every known
 * inversion (the 2 generic shapes + one per real explainer) MUST throw.
 */
import { describe, expect, it } from 'vitest'
import { CausalityError, captionsToSteps, multiSyncStory, syncStory } from '../../kit/syncStory.ts'
import { sqliteStory } from '../../explainers/src/sqlite.tsx'
import { mdLocalStory, mdRemoteStory, mdSharedStory } from '../../explainers/src/md.tsx'
import { reactStory } from '../../explainers/src/react.tsx'
import { codegenStory } from '../../explainers/src/codegen.tsx'
import { iacStory } from '../../explainers/src/iac.tsx'

describe('real explainer stories construct (cause before effect holds)', () => {
  it('sqlite story constructs with the expected shape', () => {
    expect(sqliteStory.steps.length).toBe(4)
  })

  it('all three md stories construct (push / reversed pull / two-way shared)', () => {
    expect(mdLocalStory.steps.length).toBe(3)
    expect(mdLocalStory.direction).toBe('push')
    expect(mdRemoteStory.steps.length).toBe(4)
    expect(mdRemoteStory.direction).toBe('pull')
    // reversed pull: the IDE RECEIVES, Notion originates
    expect(mdRemoteStory.roleOf('pricing', 'ide')).toBe('recv')
    expect(mdRemoteStory.roleOf('pricing', 'notion')).toBe('orig')
    // two-way shared: two crossing edits
    expect(mdSharedStory.edits.length).toBe(2)
    expect(mdSharedStory.direction).toBe('two')
    expect(mdSharedStory.roleOf('pricing', 'ide')).toBe('orig')
    expect(mdSharedStory.roleOf('enterprise', 'ide')).toBe('recv')
  })

  it('react / codegen / iac stories construct (all gated to packet arrival)', () => {
    // react: local→remote hop (ide edit → notion block), gated r3b
    expect(reactStory.steps.length).toBe(4)
    expect(reactStory.local?.pane).toBe('ide')
    expect(reactStory.remote.pane).toBe('notion')
    expect(reactStory.gatedRevealClass(reactStory.remote.swap.at)).toBe('r3b')
    // codegen: NO local pane (the command IS the action), single remote effect gated r2b
    expect(codegenStory.steps.length).toBe(4)
    expect(codegenStory.local).toBeUndefined()
    expect(codegenStory.remote.pane).toBe('ide')
    expect(codegenStory.gatedRevealClass(codegenStory.remote.swap.at)).toBe('r2b')
    // iac: NO local pane, single remote effect gated r3b
    expect(iacStory.steps.length).toBe(4)
    expect(iacStory.local).toBeUndefined()
    expect(iacStory.remote.pane).toBe('notion')
    expect(iacStory.gatedRevealClass(iacStory.remote.swap.at)).toBe('r3b')
  })
})

describe('causal inversions throw CausalityError (an inversion cannot ship)', () => {
  it('step-granular: remote effect at an EARLIER step than the sync', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['idle', 'edit', 'sync', 'settled']),
        local: { pane: 'db', swap: { was: 'In Progress', now: 'Done', at: { step: 2 } } },
        sync: { step: 3, duration: 1450 },
        remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 2 } } }, // BUG
      }),
    ).toThrow(CausalityError)
  })

  it('intra-step: effect painted at +700ms while the packet is still crossing (+1450ms)', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['idle', 'edit', 'sync', 'settled']),
        sync: { step: 3, duration: 1450 },
        // BUG: right step, but WHILE the packet is still in flight.
        remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 3, delay: 700 } } },
      }),
    ).toThrow(CausalityError)
  })

  it('single-step (codegen/iac shape, no gate): effect at step entry, before the read resolves', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['point at DB', 'generate', 'autocomplete', 'CI drift']),
        sync: { step: 2, duration: 1400 },
        // BUG: generated code reveals at step-2 entry, before the read completes.
        remote: { pane: 'ide', swap: { was: '(empty)', now: 'schema.gen.ts', at: { step: 2, delay: 0 } } },
      }),
    ).toThrow(CausalityError)
  })

  it('md pull inversion: IDE receiver flips at step 2, before the packet arrives', () => {
    expect(() =>
      multiSyncStory({
        steps: captionsToSteps(['source: remote', 'teammate edits', 'pull', 'warn']),
        sync: { step: 3, duration: 1150 },
        direction: 'pull',
        edits: [
          {
            label: 'pricing',
            from: 'notion',
            to: 'ide',
            editAt: { step: 2 },
            // BUG: the file receives at step 2, before the sync packet arrives {3,+1150}.
            receiveAt: { step: 2 },
            swap: { was: '$25', now: '$30', at: { step: 2 } },
          },
        ],
      }),
    ).toThrow(CausalityError)
  })

  it('react inversion: Notion block flips at step-3 entry, before the rerun packet arrives', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['written as JSX', 'run → whole page', 'edit one line → one block', 'unchanged → no-op']),
        local: { pane: 'ide', swap: { was: '$40k', now: '$80k', at: { step: 3 } } },
        sync: { step: 3, duration: 1450 },
        // BUG: effect at t=0 of step 3 — right step, but before the packet lands (+1450ms).
        remote: { pane: 'notion', swap: { was: '$40k', now: '$80k', at: { step: 3, delay: 0 } } },
      }),
    ).toThrow(CausalityError)
  })

  it('codegen inversion: schema materializes at step-2 entry, before the read completes', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['point at DB', 'generate', 'autocomplete', 'CI drift']),
        sync: { step: 2, duration: 1350 },
        // BUG: `export const Task = …` present at step-2 entry, before the read packet arrives.
        remote: { pane: 'ide', swap: { was: 'schema.gen.ts — empty', now: 'export const Task = …', at: { step: 2, delay: 0 } } },
      }),
    ).toThrow(CausalityError)
  })

  it('iac inversion: Notion provisions at step-3 entry, before the apply packet arrives', () => {
    expect(() =>
      syncStory({
        steps: captionsToSteps(['declare', 'plan', 'apply', 'refuse']),
        sync: { step: 3, duration: 1400 },
        // BUG: Notion shows provisioned at t=0 of step 3, before the write packet arrives.
        remote: { pane: 'notion', swap: { was: 'empty', now: 'provisioned', at: { step: 3, delay: 0 } } },
      }),
    ).toThrow(CausalityError)
  })
})

describe('positive control', () => {
  it('the same single-step shape, correctly gated to arrival, constructs', () => {
    const gated = syncStory({
      steps: captionsToSteps(['point at DB', 'generate', 'autocomplete', 'CI drift']),
      sync: { step: 2, duration: 1400 },
      remote: { pane: 'ide', swap: { was: '(empty)', now: 'schema.gen.ts', at: { step: 2, delay: 1400 } } },
    })
    expect(gated.arrival.step).toBe(2)
    expect(gated.arrival.delay).toBe(1400)
  })
})
