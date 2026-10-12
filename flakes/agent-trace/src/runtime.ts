import { Schema } from 'effect'

import { AgentTraceRuntimeV1, AgentTraceV2, strict } from './schema.ts'

/** Facts belonging to an artifact event, never to the mutable runtime file. */
export const ArtifactFacts = Schema.Struct({
  id: AgentTraceV2.fields.id,
  at: AgentTraceV2.fields.at,
  artifact: AgentTraceV2.fields.artifact,
})
export type ArtifactFacts = typeof ArtifactFacts.Type
const validateRuntime = Schema.decodeUnknownSync(AgentTraceRuntimeV1, strict)
const validateFacts = Schema.decodeUnknownSync(ArtifactFacts, strict)
const validateEvent = Schema.decodeUnknownSync(AgentTraceV2, strict)

/** Captures the current private runtime-file value at the artifact event.
 * No filesystem or ambient state is read here: producers supply the snapshot
 * and event facts. Idle runtime records decode, but cannot produce an event
 * until they have a purpose; capture never fabricates a mission or step.
 */
export const captureArtifact = ({
  runtime,
  facts,
}: {
  runtime: AgentTraceRuntimeV1
  facts: ArtifactFacts
}): AgentTraceV2 => {
  const snapshot = validateRuntime(runtime)
  return validateEvent({
    type: 'agent-trace/v2',
    ...validateFacts(facts),
    who: snapshot.who,
    ...(snapshot.why === undefined ? {} : { why: snapshot.why }),
    how: snapshot.how,
    where: snapshot.where,
  })
}
