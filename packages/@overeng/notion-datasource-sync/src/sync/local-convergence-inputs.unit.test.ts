import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Hash, PageId, PropertyId } from '../core/domain.ts'
import { convergenceHash, nmdPropertyCanonicalValue } from '../planner/nmd-property-facts.ts'
import type { ReplicaCellBase } from '../replica/replica.ts'
import { hashStoreBytes } from '../store/projections.ts'
import { dataFilePropertyEdits, nmdPropertyFacts } from './local-convergence-inputs.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(s: TSchema, v: unknown) =>
  Schema.decodeUnknownSync(s)(v)

const pageId = decode(PageId, 'page-1')
const propertyId = decode(PropertyId, 'p-priority')
const dataSourceId = 'data-source-1'

/** The pristine remote base hash for a select value, as `remote_hash` would carry it. */
const selectRemoteHash = (name: string): string =>
  convergenceHash(JSON.stringify(nmdPropertyCanonicalValue({ _tag: 'select', value: name })!))

const cellBase = (remoteName: string): ReplicaCellBase => ({
  pageId,
  dataSourceId,
  propertyId,
  propertyName: 'Priority',
  propertyType: 'select',
  // The cell value_json is the EDIT-overwritten value; convergence must NOT use it.
  valueJson: JSON.stringify({
    _tag: 'select',
    option: { _tag: 'CanonicalOptionValue', name: 'EDITED' },
  }),
  remoteHash: selectRemoteHash(remoteName),
})

describe('local-convergence inputs (baseline diff)', () => {
  it('emits NO .nmd fact when the .nmd value matches the pristine remote base (untouched .nmd)', () => {
    // Base remote = 'Low'; .nmd still holds 'Low' (untouched), even though the
    // cell value_json was overwritten by a SQLite edit to 'EDITED'. Diffing
    // against remote_hash (not value_json) is what prevents the false conflict.
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Priority: { _tag: 'select', value: 'Low' } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(0)
  })

  it('emits a .nmd fact when the .nmd value differs from the pristine remote base (real .nmd edit)', () => {
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Priority: { _tag: 'select', value: 'High' } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.identity).toEqual({ kind: 'property', pageId, propertyId })
    expect(facts[0]?.desiredHash).toBe(selectRemoteHash('High'))
    expect(facts[0]?.baseHash).toBe(selectRemoteHash('Low'))
  })

  it('fails closed when a .nmd property name resolves to no tracked property (no fact)', () => {
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Unknown: { _tag: 'select', value: 'High' } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(0)
  })

  it('skips non-scalar .nmd property tags (not convergence-comparable)', () => {
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Priority: { _tag: 'multi_select', value: ['a'] } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(0)
  })

  it('projects a cell_patch into a property DataFileLocalEdit using the convergence hash', () => {
    const valueJson = JSON.stringify({
      _tag: 'select',
      option: { _tag: 'CanonicalOptionValue', name: 'High' },
    })
    const baseByCell = new Map<string, ReplicaCellBase>([
      [`${pageId as string} ${propertyId as string}`, cellBase('Low')],
    ])
    const edits = dataFilePropertyEdits({
      changes: [
        {
          changeId: 'c1',
          kind: 'cell_patch',
          dataSourceId,
          pageId,
          propertyId,
          valueJson,
          baseHash: undefined,
          status: 'pending',
          bodyPath: undefined,
          localBodyHash: undefined,
          localBodyContent: undefined,
          metadataResourceType: undefined,
          databaseId: undefined,
          titlePlainText: undefined,
          descriptionPlainText: undefined,
          schemaOperationJson: undefined,
          fileAssetId: undefined,
          fileAction: undefined,
          fileName: undefined,
          fileExternalUrl: undefined,
          conflictId: undefined,
          resolutionAction: undefined,
          localRowId: undefined,
          clientRequestKey: undefined,
          remotePageId: undefined,
        },
      ],
      baseByCell,
    })
    expect(edits).toHaveLength(1)
    expect(edits[0]?.identity).toEqual({ kind: 'property', pageId, propertyId })
    // The engine-facing comparison hash is the CONVERGENCE hash of the edited
    // value_json (not the raw remote-write desiredHash).
    expect(edits[0]?.desiredHash).toBe(convergenceHash(valueJson))
  })

  it('hash sanity: convergence hash equals a known Hash brand format', () => {
    expect(selectRemoteHash('X')).toMatch(/^sha256:[0-9a-f]{64}$/)
    void Hash
  })

  it('INVARIANT: convergenceHash is identity-on-bytes for clean codec JSON (the remote_hash space)', () => {
    // Production `remote_hash` = hashStoreBytes(inlineValueJson) over clean codec
    // output (observation.ts). The baseline diff compares an `.nmd` convergence
    // hash against that `remote_hash`, so `convergenceHash` MUST equal
    // `hashStoreBytes` on clean codec JSON (parse→stringify is identity there; the
    // REAL number coercion only happens on the SQLite *edit* path). Pin it so the
    // cross-space assumption cannot silently drift.
    for (const value of [
      { _tag: 'select' as const, value: 'High' },
      { _tag: 'title' as const, value: 'Hello' },
      { _tag: 'number' as const, value: 7 },
      { _tag: 'checkbox' as const, value: true },
    ]) {
      const cleanJson = JSON.stringify(nmdPropertyCanonicalValue(value)!)
      expect(convergenceHash(cleanJson)).toBe(hashStoreBytes(cleanJson))
    }
  })
})
