/** Reusable public agent telemetry vocabulary; contains no deployment-specific identities. */
import { attr, defineOtelContract, optIn, recommended, refExternal, span } from './registry.ts'

/** Logical actor identity; stable across provider-native harness sessions. */
export const AgentActorId = attr.string({
  key: 'agent.actor.id',
  cardinality: 'high',
  brief: 'Stable logical agent actor identity, independent of any harness session.',
  stability: 'development',
  examples: ['actor-001'],
  constName: 'AGENT_ACTOR_ID',
})

/** Bounded persona name describing the actor's behavior. */
export const AgentPersona = attr.string({
  key: 'agent.persona',
  cardinality: 'bounded',
  brief: 'The agent persona name.',
  stability: 'development',
  examples: ['reviewer'],
  constName: 'AGENT_PERSONA',
})

/** Parent actor identity for supervised agent activity. */
export const AgentSupervisorId = attr.string({
  key: 'agent.supervisor.id',
  cardinality: 'high',
  brief: 'The logical actor identity of the supervising agent.',
  stability: 'development',
  examples: ['actor-002'],
  constName: 'AGENT_SUPERVISOR_ID',
})

/** Mission name shared by executions of the same mission. */
export const AgentMissionName = attr.string({
  key: 'agent.mission.name',
  cardinality: 'bounded',
  brief: 'The mission name.',
  stability: 'development',
  examples: ['code-review'],
  constName: 'AGENT_MISSION_NAME',
})

/** Unique mission execution identity; trace-only rather than a metric label. */
export const AgentMissionRunId = attr.string({
  key: 'agent.mission.run.id',
  cardinality: 'high',
  brief: 'The identity of one mission execution.',
  stability: 'development',
  examples: ['mission-run-001'],
  constName: 'AGENT_MISSION_RUN_ID',
})

/** Step name within a mission, independent of its execution identity. */
export const AgentStepName = attr.string({
  key: 'agent.step.name',
  cardinality: 'bounded',
  brief: 'The mission step name.',
  stability: 'development',
  examples: ['inspect'],
  constName: 'AGENT_STEP_NAME',
})

/** Unique step execution identity; trace-only rather than a metric label. */
export const AgentStepRunId = attr.string({
  key: 'agent.step.run.id',
  cardinality: 'high',
  brief: 'The identity of one step execution.',
  stability: 'development',
  examples: ['step-run-001'],
  constName: 'AGENT_STEP_RUN_ID',
})

/** Provider-native harness tool name. */
export const AgentHarnessTool = attr.string({
  key: 'agent.harness.tool',
  cardinality: 'bounded',
  brief: 'The provider-native agent harness tool name.',
  stability: 'development',
  examples: ['example-harness'],
  constName: 'AGENT_HARNESS_TOOL',
})

/** Harness software version, separate from the selected model. */
export const AgentHarnessVersion = attr.string({
  key: 'agent.harness.version',
  cardinality: 'bounded',
  brief: 'The agent harness version.',
  stability: 'development',
  examples: ['1.0.0'],
  constName: 'AGENT_HARNESS_VERSION',
})

/** Provider-native session identity, never a PTY session or logical actor identity. */
export const AgentHarnessSessionId = attr.string({
  key: 'agent.harness.session.id',
  cardinality: 'high',
  brief: 'The provider-native harness session identity.',
  stability: 'development',
  examples: ['harness-session-001'],
  constName: 'AGENT_HARNESS_SESSION_ID',
  note: 'A provider-native harness session, distinct from a PTY session and from the logical agent actor identity. Never substitute a PTY identity or actor identity for this value.',
})

/** Requested reasoning effort, distinct from the upstream model name. */
export const AgentModelEffort = attr.string({
  key: 'agent.model.effort',
  cardinality: 'bounded',
  brief: 'The requested model reasoning effort.',
  stability: 'development',
  examples: ['high'],
  constName: 'AGENT_MODEL_EFFORT',
})

/** Opt-in internal principal identity; never public or a metric label. */
export const AgentPrincipalId = attr.string({
  key: 'agent.principal.id',
  cardinality: 'high',
  brief: 'The internal principal identity on whose behalf the agent acts.',
  stability: 'development',
  examples: ['principal-001'],
  constName: 'AGENT_PRINCIPAL_ID',
  note: 'Internal-only, opt-in identity. Never include principal values in public artifacts or metric labels.',
})

/** Upstream GenAI request model; not a first-party attribute definition. */
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
    requestedModel: refExternal({ schema: GenAiRequestModel, requirement: 'recommended' }),
  },
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/otel-contract',
  displayName: 'Agent Attributes',
  upstream: [
    {
      dependency: {
        name: 'semantic-conventions-genai',
        registry_path:
          'https://github.com/open-telemetry/semantic-conventions-genai.git@6fd0d763a092db245a54104fc1124031eb3c51d2[model]',
        schema_url: 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev',
      },
      providesNamespaces: ['gen_ai'],
    },
  ],
  signals: [AgentActivity],
})
