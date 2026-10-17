/**
 * Cross-package structural assignability test: `PropertyWriteGuardDecision`
 * (from `@overeng/notion-property-write`) must be assignable to datasource-sync
 * `GuardDecision` (same `{ _tag }` shape). This is the contract the planner
 * swap in 3c-ii relies on: `evaluatePropertyWrite(...)` output can be pushed
 * straight into the guard pipeline without mapping.
 */
import { describe, expect, it } from 'vitest'

import { allowed as pwAllowed, blocked as pwBlocked } from '@overeng/notion-property-write'

import type { GuardDecision } from './guards.ts'
import { blocked } from './guards.ts'

describe('PropertyWriteGuardDecision ⊆ GuardDecision (structural assignability)', () => {
  it('allowed decision is assignable', () => {
    // tsc-level fixture: if this assignment compiles, the shapes are compatible.
    const decision: GuardDecision = pwAllowed()
    expect(decision._tag).toBe('allowed')
  })

  it('blocked decision is assignable', () => {
    const decision: GuardDecision = pwBlocked({
      guard: 'ComputedPropertyWrite',
      message: 'Computed Notion properties cannot be written',
    })
    expect(decision._tag).toBe('blocked')
    if (decision._tag === 'blocked') {
      expect(decision.guard).toBe('ComputedPropertyWrite')
    }
  })

  it('blocked().guard round-trips through GuardDecision', () => {
    const guardName = 'ReadAfterWriteMismatch' as const
    const message = 'Read-after-write settlement is missing'
    // Constructed via datasource-sync blocked() — same shape, different origin.
    const dsDecision: GuardDecision = blocked({ guard: guardName, message })
    expect(dsDecision._tag).toBe('blocked')
    if (dsDecision._tag === 'blocked') {
      expect(dsDecision.guard).toBe(guardName)
      expect(dsDecision.message).toBe(message)
    }
  })
})
