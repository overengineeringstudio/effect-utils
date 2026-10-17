/**
 * Pure, entrypoint-neutral property-write safety core for Notion sync.
 *
 * @module
 */

export { evaluatePropertyWrite } from './core.ts'
export {
  allowed,
  blocked,
  PropertyWriteGuardDecision,
  type PropertyWriteGuardDecision as PropertyWriteGuardDecisionType,
  PropertyWriteGuardName,
  type PropertyWriteGuardName as PropertyWriteGuardNameType,
  propertyWriteGuardNames,
} from './guards.ts'
export {
  decodeDesiredPropertyWrite,
  decodePropertyWriteProof,
  DesiredPropertyWrite,
  type DesiredPropertyWrite as DesiredPropertyWriteType,
  PropertyWriteBaseCompleteness,
  type PropertyWriteBaseCompleteness as PropertyWriteBaseCompletenessType,
  PropertyWriteIdentity,
  type PropertyWriteIdentity as PropertyWriteIdentityType,
  PropertyWriteLocalConvergence,
  type PropertyWriteLocalConvergence as PropertyWriteLocalConvergenceType,
  PropertyWriteMode,
  type PropertyWriteMode as PropertyWriteModeType,
  PropertyWriteProof,
  type PropertyWriteProof as PropertyWriteProofType,
  PropertyWriteRelationAvailability,
  type PropertyWriteRelationAvailability as PropertyWriteRelationAvailabilityType,
  PropertyWriteSchemaConsistency,
  type PropertyWriteSchemaConsistency as PropertyWriteSchemaConsistencyType,
  PropertyWriteSettlement,
  type PropertyWriteSettlement as PropertyWriteSettlementType,
} from './proof.ts'
