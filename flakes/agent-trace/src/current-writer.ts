import { object } from './projection.ts'
/** Fresh writers must provide accountable identities, purpose and runtime facts.
 * Legacy decoders deliberately do not call this: missing historical observations
 * remain absent in the upgraded binding view rather than becoming invented facts.
 */
export const assertCurrentWriter = (input: unknown): void => {
  const record = object(input),
    who = object(record.who),
    how = object(record.how),
    why = object(record.why)
  const harness = how.harness === undefined ? undefined : object(how.harness)
  const model = how.model === undefined ? undefined : object(how.model)
  if (
    typeof who.agent !== 'string' ||
    typeof who.principal !== 'string' ||
    typeof harness?.tool !== 'string' ||
    typeof model?.route !== 'string'
  )
    throw new TypeError(
      'Current writer requires who.agent, who.principal, how.harness and how.model',
    )
  if (
    !Object.hasOwn(why, 'mission') &&
    !Object.hasOwn(why, 'step') &&
    !Object.hasOwn(why, 'related')
  )
    throw new TypeError('Current writer requires why context or a related link')
}
