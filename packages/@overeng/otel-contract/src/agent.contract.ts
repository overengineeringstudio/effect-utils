/** Reusable public agent telemetry vocabulary; contains no deployment-specific identities. */
import { attr, defineOtelContract, optIn, recommended, refExternal, span } from './registry.ts'

export const AgentActorId = attr.string({
  key: 'agent.actor.id',
  cardinality: 'high',
  brief: 'Stable logical agent actor identity, independent of any harness session.',
  stability: 'development',
  examples: ['actor-001'],
  constName: 'AGENT_ACTOR_ID',
})

export const AgentPersona = attr.string({
  key: 'agent.persona',
  cardinality: 'bounded',
  brief: 'The agent persona name.',
  stability: 'development',
  examples: ['reviewer'],
  constName: 'AGENT_PERSONA',
})

export const AgentSupervisorId = attr.string({
  key: 'agent.supervisor.id',
  cardinality: 'high',
  brief: 'The logical actor identity of the supervising agent.',
  stability: 'development',
  examples: ['actor-002'],
  constName: 'AGENT_SUPERVISOR_ID',
})

export const AgentMissionName = attr.string({
  key: 'agent.mission.name',
  cardinality: 'bounded',
  brief: 'The mission name.',
  stability: 'development',
  examples: ['code-review'],
  constName: 'AGENT_MISSION_NAME',
})

export const AgentMissionRunId = attr.string({
  key: 'agent.mission.run.id',
  cardinality: 'high',
  brief: 'The identity of one mission execution.',
  stability: 'development',
  examples: ['mission-run-001'],
  constName: 'AGENT_MISSION_RUN_ID',
})

export const AgentStepName = attr.string({
  key: 'agent.step.name',
  cardinality: 'bounded',
  brief: 'The mission step name.',
  stability: 'development',
  examples: ['inspect'],
  constName: 'AGENT_STEP_NAME',
})

export const AgentStepRunId = attr.string({
  key: 'agent.step.run.id',
  cardinality: 'high',
  brief: 'The identity of one step execution.',
  stability: 'development',
  examples: ['step-run-001'],
  constName: 'AGENT_STEP_RUN_ID',
})

export const AgentHarnessTool = attr.string({
  key: 'agent.harness.tool',
  cardinality: 'bounded',
  brief: 'The provider-native agent harness tool name.',
  stability: 'development',
  examples: ['example-harness'],
  constName: 'AGENT_HARNESS_TOOL',
})

export const AgentHarnessVersion = attr.string({
  key: 'agent.harness.version',
  cardinality: 'bounded',
  brief: 'The agent harness version.',
  stability: 'development',
  examples: ['1.0.0'],
  constName: 'AGENT_HARNESS_VERSION',
})

export const AgentHarnessSessionId = attr.string({
  key: 'agent.harness.session.id',
  cardinality: 'high',
  brief: 'The provider-native harness session identity.',
  stability: 'development',
  examples: ['harness-session-001'],
  constName: 'AGENT_HARNESS_SESSION_ID',
  note: 'A provider-native harness session, distinct from a PTY session and from the logical agent actor identity. Never substitute a PTY identity or actor identity for this value.',
})

export const AgentModelEffort = attr.string({
  key: 'agent.model.effort',
  cardinality: 'bounded',
  brief: 'The requested model reasoning effort.',
  stability: 'development',
  examples: ['high'],
  constName: 'AGENT_MODEL_EFFORT',
})

export const AgentPrincipalId = attr.string({
  key: 'agent.principal.id',
  cardinality: 'high',
  brief: 'The internal principal identity on whose behalf the agent acts.',
  stability: 'development',
  examples: ['principal-001'],
  constName: 'AGENT_PRINCIPAL_ID',
  note: 'Internal-only, opt-in identity. Never include principal values in public artifacts or metric labels.',
})

/** Reference the upstream GenAI model key rather than defining a first-party replacement. */
export const GenAiRequestModel = attr.string({
  key: 'gen_ai.request.model',
  cardinality: 'bounded',
  brief: '(upstream OTel) The requested generative AI model name.',
  stability: 'development',
  examples: ['example-model'],
})

/** Shared attribute shape for agent activity; producers may reuse its encoder. */
export const AgentActivity = span({
  id: 'span.agent.activity',
  kind: 'internal',
  brief: 'Agent activity with logical actor, mission, step, and provider-native harness context.',
  stability: 'development',
  constName: 'AGENT_ACTIVITY',
  attributes: {
    actorId: recommended(AgentActorId),
    persona: recommended(AgentPersona),
    supervisorId: recommended(AgentSupervisorId),
    missionName: recommended(AgentMissionName),
    missionRunId: recommended(AgentMissionRunId),
    stepName: recommended(AgentStepName),
    stepRunId: recommended(AgentStepRunId),
    harnessTool: recommended(AgentHarnessTool),
    harnessVersion: recommended(AgentHarnessVersion),
    harnessSessionId: recommended(AgentHarnessSessionId),
    modelEffort: recommended(AgentModelEffort),
    principalId: optIn(AgentPrincipalId),
    requestModel: refExternal({ schema: GenAiRequestModel, requirement: 'recommended' }),
  },
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/otel-contract',
  displayName: 'Agent Attributes',
  signals: [AgentActivity],
})
