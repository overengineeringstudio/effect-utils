import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeCanonicalCodec } from '@overeng/notion-effect-schema'

import { canonicalHash } from '../core/canonical.ts'
import { Hash, PageId, PropertyId } from '../core/domain.ts'
import { convergenceFormHash, nmdPropertyCanonicalValue } from '../planner/nmd-property-facts.ts'
import type { ReplicaCellBase } from '../replica/replica.ts'
import { hashStoreBytes } from '../store/projections.ts'
import { dataFilePropertyEdits, nmdPropertyFacts } from './local-convergence-inputs.ts'

const decode = <TSchema extends Schema.Codec<any, any, never>>(s: TSchema, v: unknown) =>
  Schema.decodeUnknownSync(s)(v)

const pageId = decode(PageId, 'page-1')
const propertyId = decode(PropertyId, 'p-priority')
const dataSourceId = 'data-source-1'

const codec = makeCanonicalCodec({ hash: (value) => canonicalHash(value) })

/**
 * The FULL canonical `value_json` a real remote select observation produces: the
 * codec keeps the option `id` + `color` (`canonicalOptionFromRemote`). This is the
 * shape `remote_hash` and `value_json` carry in production — deliberately NOT the
 * name-only `.nmd` shape, so the base and the `.nmd` side live in different spaces
 * and the test can catch a cross-space comparability bug.
 */
const remoteSelectValueJson = (name: string): string => {
  const canonical = Option.getOrThrow(
    codec.decodeSync({
      type: 'select',
      select: { id: `opt-${name}`, name, color: 'blue' },
    }),
  )
  return JSON.stringify(canonical)
}

/**
 * A cell base exactly as `readReplicaCellBases` returns it from a real pull:
 * `remoteHash` is the FULL canonical hash (id+color), `convergenceHash` is the
 * name-only fold (`convergenceFormHash`), and `valueJson` is the EDIT-overwritten
 * value (convergence must use neither `remoteHash` nor `valueJson` as the base).
 */
const cellBase = (remoteName: string): ReplicaCellBase => {
  const fullJson = remoteSelectValueJson(remoteName)
  return {
    pageId,
    dataSourceId,
    propertyId,
    propertyName: 'Priority',
    propertyType: 'select',
    valueJson: JSON.stringify({
      _tag: 'select',
      option: { _tag: 'CanonicalOptionValue', name: 'EDITED' },
    }),
    remoteHash: hashStoreBytes(fullJson),
    convergenceHash: convergenceFormHash(fullJson),
  }
}

describe('local-convergence inputs (baseline diff)', () => {
  it('CROSS-SPACE: an UNTOUCHED .nmd select (name-only) produces ZERO facts against a real id+color remote base', () => {
    // The realistic regression: the remote base keeps option id+color, the `.nmd`
    // value is name-only. Before the `convergence_hash` fix, the `.nmd` side was
    // diffed against `remote_hash` (full canonical), so an UNTOUCHED select hashed
    // unequal → a spurious fact that would block a legitimate SQLite edit. With the
    // name-only `convergence_hash` base, an untouched value yields no fact.
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Priority: { _tag: 'select', value: 'Low' } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(0)
  })

  it('emits a .nmd fact when the .nmd value differs from the pristine convergence base (real .nmd edit)', () => {
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Priority: { _tag: 'select', value: 'High' } } }],
      bases: [cellBase('Low')],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.identity).toEqual({ kind: 'property', pageId, propertyId })
    expect(facts[0]?.desiredHash).toBe(
      convergenceFormHash(
        JSON.stringify(nmdPropertyCanonicalValue({ _tag: 'select', value: 'High' })!),
      ),
    )
    expect(facts[0]?.baseHash).toBe(cellBase('Low').convergenceHash)
  })

  it('CROSS-SPACE (null number): an UNTOUCHED cleared .nmd number produces ZERO facts vs a SQLite-shape base', () => {
    // SQLite emits `{_tag:'number','value':null}` for a cleared number; the codec
    // emits `{_tag:'empty'}`. `convergenceFormHash` folds both to `empty`, so a
    // cleared number is convergent. (Build the base directly in the SQLite shape.)
    const sqliteNullNumberJson = JSON.stringify({ _tag: 'number', value: null })
    const base: ReplicaCellBase = {
      pageId,
      dataSourceId,
      propertyId,
      propertyName: 'Estimate',
      propertyType: 'number',
      valueJson: JSON.stringify({ _tag: 'number', value: 99 }),
      remoteHash: hashStoreBytes(sqliteNullNumberJson),
      convergenceHash: convergenceFormHash(sqliteNullNumberJson),
    }
    const facts = nmdPropertyFacts({
      surfaces: [{ pageId, properties: { Estimate: { _tag: 'number', value: null } } }],
      bases: [base],
    })
    expect(facts).toHaveLength(0)
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

  it('projects a cell_patch into a property DataFileLocalEdit using the convergence-form hash', () => {
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
    // The engine-facing comparison hash is the CONVERGENCE-FORM hash of the edited
    // value_json (not the raw remote-write desiredHash); the base is the cell's
    // pristine `convergence_hash`, never re-derived from the edit-overwritten value.
    expect(edits[0]?.desiredHash).toBe(convergenceFormHash(valueJson))
    expect(edits[0]?.baseHash).toBe(cellBase('Low').convergenceHash)
  })

  it('hash sanity: convergence-form hash equals a known Hash brand format', () => {
    expect(convergenceFormHash(remoteSelectValueJson('X'))).toMatch(/^sha256:[0-9a-f]{64}$/)
    void Hash
  })
})
