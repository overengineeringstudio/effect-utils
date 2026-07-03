import { describe, expect, it } from 'vitest'

import type { RegistryFragment as OtelRegistryFragment } from '@overeng/otel-contract/registry'

import type { RegistryFragment } from '../weaver/mod.ts'
import { orphanSeamPaths, type RegistryMember, registryFromMembers } from './mod.ts'

// Compile-time drift guard: `@overeng/otel-contract` `./registry` cannot import genie (cycle),
// so it re-declares a mirror of this Layer-1 `RegistryFragment`. genie CAN type-import otel-
// contract (allowed direction), so this assignment fails to compile if the mirrors drift apart.
const _driftGuard = (f: OtelRegistryFragment): RegistryFragment => f
void _driftGuard

const member = (f: RegistryFragment): RegistryMember => ({
  data: f,
  stringify: () => '',
  meta: { registry: f },
})

const acme: RegistryFragment = {
  namespace: 'acme',
  memberPath: 'packages/acme',
  displayName: 'Acme',
  attributes: [
    { id: 'acme.name', type: 'string', brief: 'n', stability: 'development', examples: ['x'] },
  ],
  foreignRefs: [],
  signals: [
    {
      kind: 'span',
      id: 'span.acme.x',
      span_kind: 'internal',
      brief: 'x',
      stability: 'development',
      attributes: [{ ref: 'acme.name', requirement_level: 'required' }],
    },
  ],
}

describe('registryFromMembers (SC-R08/R09)', () => {
  it('composes cleanly with no integrity issues', () => {
    const { registry, issues } = registryFromMembers({
      members: [member(acme)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues).toEqual([])
    expect(registry.groups.map((g) => g.namespace)).toEqual(['acme'])
  })

  it('reports a duplicate-namespace issue when two members claim the same namespace', () => {
    const { issues } = registryFromMembers({
      members: [member(acme), member({ ...acme, memberPath: 'packages/acme2' })],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues.some((i) => i.rule === 'weaver/duplicate-namespace')).toBe(true)
  })

  it('reports a dangling-ref issue for a cross-member ref that resolves nowhere', () => {
    const dangling: RegistryFragment = {
      ...acme,
      namespace: 'beta',
      memberPath: 'packages/beta',
      attributes: [
        { id: 'beta.k', type: 'string', brief: 'k', stability: 'development', examples: ['x'] },
      ],
      signals: [
        {
          kind: 'span',
          id: 'span.beta.y',
          span_kind: 'internal',
          brief: 'y',
          stability: 'development',
          // references acme.name, which is NOT present when acme is absent → dangling.
          attributes: [{ ref: 'acme.name', requirement_level: 'required' }],
        },
      ],
    }
    const { issues } = registryFromMembers({
      members: [member(dangling)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
    })
    expect(issues.some((i) => i.rule === 'weaver/dangling-ref')).toBe(true)
  })

  it('defers upstream-namespaced refs to weaver (no dangling issue)', () => {
    const withUpstream: RegistryFragment = {
      ...acme,
      signals: [
        {
          kind: 'span',
          id: 'span.acme.http',
          span_kind: 'client',
          brief: 'h',
          stability: 'development',
          attributes: [
            { ref: 'acme.name', requirement_level: 'required' },
            { ref: 'http.request.method', requirement_level: 'recommended' },
          ],
        },
      ],
    }
    const { issues } = registryFromMembers({
      members: [member(withUpstream)],
      name: 'r',
      description: 'd',
      schemaUrl: 's',
      upstream: [
        { dependency: { name: 'otel', registry_path: 'x' }, providesNamespaces: ['http'] },
      ],
    })
    expect(issues).toEqual([])
  })
})

describe('orphanSeamPaths (decision 0005 keystone)', () => {
  it('returns [] when every seam on disk is imported', () => {
    expect(
      orphanSeamPaths({
        seamFilesOnDisk: ['a/x.contract.ts'],
        importedSeamPaths: ['a/x.contract.ts'],
      }),
    ).toEqual([])
  })

  it('FAILS (reports the orphan) when a seam is on disk but not imported', () => {
    expect(
      orphanSeamPaths({
        seamFilesOnDisk: ['a/x.contract.ts', 'b/orphan.contract.ts'],
        importedSeamPaths: ['a/x.contract.ts'],
      }),
    ).toEqual(['b/orphan.contract.ts'])
  })
})
