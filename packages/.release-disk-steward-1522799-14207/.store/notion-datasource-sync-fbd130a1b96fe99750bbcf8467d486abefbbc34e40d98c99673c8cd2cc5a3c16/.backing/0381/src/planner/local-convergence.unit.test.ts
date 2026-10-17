import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Hash, PageId, PropertyId } from '../core/domain.ts'
import {
  applyConvergenceVerdicts,
  convergeLocalSurfaces,
  type DataFileLocalEdit,
  type LocalIdentity,
  type NmdDesiredFact,
} from './local-convergence.ts'

const decode = <TSchema extends Schema.Codec<any, any, never>>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)
const pageId = decode(PageId, 'page-1')
const propertyId = decode(PropertyId, 'prop-status')

const propertyIdentity: LocalIdentity = { kind: 'property', pageId, propertyId }
const bodyIdentity: LocalIdentity = { kind: 'body', pageId }

describe('local-surface convergence', () => {
  it('is not-applicable outside shared mode (single-source mirror)', () => {
    const sqlite: DataFileLocalEdit = { identity: propertyIdentity, desiredHash: hash('a') }
    const nmd: NmdDesiredFact = { identity: propertyIdentity, desiredHash: hash('b') }

    for (const authorityMode of ['local', 'remote'] as const) {
      expect(
        convergeLocalSurfaces({ authorityMode, dataFileEdits: [sqlite], nmdFacts: [nmd] }),
      ).toEqual({ _tag: 'not-applicable' })
    }
  })

  it('coalesces agreeing surfaces into one intent and a converged verdict', () => {
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [{ identity: propertyIdentity, desiredHash: hash('a') }],
      nmdFacts: [{ identity: propertyIdentity, desiredHash: hash('a') }],
    })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return

    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]?._tag).toBe('coalesced')
    expect(result.conflicts).toHaveLength(0)
    expect(result.blockedIdentities).toHaveLength(0)
    expect(result.propertyVerdicts).toEqual([{ pageId, propertyId, status: 'converged' }])
  })

  it('raises a local conflict on a divergent property and blocks remote mutation', () => {
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [{ identity: propertyIdentity, desiredHash: hash('a'), baseHash: hash('0') }],
      nmdFacts: [{ identity: propertyIdentity, desiredHash: hash('b'), baseHash: hash('0') }],
    })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return

    expect(result.outcomes[0]?._tag).toBe('local-conflict')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.kind).toBe('same-property')
    expect(result.conflicts[0]?.localHash).toBe(hash('a'))
    expect(result.conflicts[0]?.remoteHash).toBe(hash('b'))
    // Property divergence drives the `disagrees` proof verdict AND blocks the identity.
    expect(result.propertyVerdicts).toEqual([{ pageId, propertyId, status: 'disagrees' }])
    expect(result.blockedIdentities).toEqual([propertyIdentity])
  })

  it('routes a single-surface edit through as that surface intent', () => {
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [{ identity: propertyIdentity, desiredHash: hash('a') }],
      nmdFacts: [],
    })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return

    const [outcome] = result.outcomes
    expect(outcome?._tag).toBe('single-surface')
    if (outcome?._tag !== 'single-surface') return
    expect(outcome.surface).toBe('sqlite')
    expect(result.conflicts).toHaveLength(0)
    // A single-surface edit yields NO `converged` verdict: there was no second
    // surface to cross-check, so the property stays at its `not-applicable` default.
    expect(result.propertyVerdicts).toHaveLength(0)
  })

  it('routes an `.nmd`-only edit through as the nmd surface intent', () => {
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [],
      nmdFacts: [{ identity: propertyIdentity, desiredHash: hash('a') }],
    })
    if (result._tag !== 'shared') throw new Error('expected shared')
    const [outcome] = result.outcomes
    expect(outcome?._tag).toBe('single-surface')
    if (outcome?._tag !== 'single-surface') return
    expect(outcome.surface).toBe('nmd')
  })

  it('classifies body divergence as a body conflict with no property verdict', () => {
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [{ identity: bodyIdentity, desiredHash: hash('a') }],
      nmdFacts: [{ identity: bodyIdentity, desiredHash: hash('b') }],
    })
    if (result._tag !== 'shared') throw new Error('expected shared')
    expect(result.conflicts[0]?.kind).toBe('body-body-delegated')
    expect(result.propertyVerdicts).toHaveLength(0)
    expect(result.blockedIdentities).toEqual([bodyIdentity])
  })

  it('overlays property verdicts onto planner surfaces, leaving unevaluated surfaces untouched', () => {
    const otherPropertyId = decode(PropertyId, 'prop-other')
    const surfaces = [
      { pageId, propertyId, localConvergence: 'not-applicable' as const },
      { pageId, propertyId: otherPropertyId, localConvergence: 'not-applicable' as const },
    ]
    const overlaid = applyConvergenceVerdicts({
      properties: surfaces,
      verdicts: [{ pageId, propertyId, status: 'disagrees' }],
    })
    expect(overlaid[0]?.localConvergence).toBe('disagrees')
    // The unevaluated surface keeps its default verdict.
    expect(overlaid[1]?.localConvergence).toBe('not-applicable')
  })
})
