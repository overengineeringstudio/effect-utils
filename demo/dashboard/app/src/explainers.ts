import type { FC } from 'react'
import { type DemoModel } from './model.gen.ts'
import { EXPLAINERS } from '../../explainers/src/registry.tsx'

// Inline explainer components, keyed by demo id (registry id === demo id for the
// ported explainers). A demo is "explainable" iff a React explainer is registered
// here — NOT whether a legacy .html exists — so unported demos (schema/react)
// still fall through to the graceful "no explainer" affordance.
export const EXPLAINER_BY_ID: Record<string, FC> = Object.fromEntries(EXPLAINERS.map((e) => [e.id, e.Component]))
export const canExplain = (d: DemoModel): boolean => d.id in EXPLAINER_BY_ID
