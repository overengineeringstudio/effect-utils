import { walkSchema, type Sensitivity } from '@schickling/schema-registry'
import { Schema, SchemaAST as AST } from 'effect'
/** Publication audience supported by this frozen authority. */
export type Audience = 'public-minimal' | 'private-rich'
/** Nonempty trimmed scalar that fits on one attribution line. */
export const Text = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isPattern(/^[^\r\n]+$/u))
/** Provider-qualified model route, limited to 64 UTF-16 code units. */
export const ModelRoute = Text.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._+-]*$/u),
)
/** Owner-derived short session lookup with optional capture-host qualification. */
export const SessionLookup = Text.check(
  Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$/u),
).pipe(Schema.brand('SessionLookup'))
const identity = Text.check(
  Schema.isPattern(
    /^(?:agent(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)?(?:direct\.[a-z0-9]+(?:-[a-z0-9]+)*\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$/u,
  ),
)
/** Host-free owner-derived short session lookup for publication. */
export const PublicSessionLookup = Text.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$/u),
).pipe(Schema.brand('PublicSessionLookup'))
/** Managed seat or unqualified direct-session identity safe for publication. */
export const PublicIdentity = Text.check(
  Schema.isPattern(
    /^(?:agent(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\.[a-z0-9]+(?:-[a-z0-9]+)*\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$/u,
  ),
)
const run = Text.check(Schema.isPattern(/^[0-9a-f]{32}$/u))
const node = <T extends Schema.Top>({
  schema,
  title,
  description,
  sensitivity = 'public',
  row = false,
  metadata = {},
}: {
  schema: T
  title: string
  description: string
  sensitivity?: Sensitivity
  row?: boolean
  metadata?: Schema.Annotations.Key<T['Type']>
}) =>
  schema.pipe(
    Schema.annotateKey({
      title,
      description,
      'x-sensitivity': sensitivity,
      'x-row': row,
      ...metadata,
    }),
  )
const optional = <T extends Schema.Top>(schema: T) => Schema.optionalKey(schema)
/** Semantic authority for one artifact-producing event; current writers require accountable identities, purpose and runtime facts. */
export const AgentTraceV2 = node({
  schema: Schema.Struct({
    type: node({
      schema: Schema.Literal('agent-trace/v2'),
      title: 'Record type',
      description: 'Versioned identifier of the semantic Agent Trace record',
    }),
    id: node({
      schema: Text,
      title: 'Event identifier',
      description: 'Identifier of this artifact-producing event',
      sensitivity: 'internal',
    }),
    at: node({
      schema: Text.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u)),
      title: 'Event time',
      description: 'UTC timestamp of this artifact-producing event',
    }),
    artifact: node({
      schema: Text,
      title: 'Artifact',
      description: 'Reference to the artifact produced by this event',
    }),
    who: node({
      schema: Schema.Struct({
        agent: node({
          schema: identity,
          title: 'Agent',
          description: 'Seat or direct-session identity responsible for producing this artifact',
          row: true,
          metadata: { 'x-public': 'strip-host' },
        }),
        principal: node({
          schema: Text,
          title: 'Accountable human',
          description: 'Human principal on whose behalf the artifact was produced',
          row: true,
        }),
        actor: node({
          schema: optional(Text),
          title: 'GitHub actor',
          description: 'GitHub account authenticated to publish this artifact',
          row: true,
        }),
        persona: node({
          schema: optional(Text),
          title: 'Persona',
          description: 'Behavioral persona used by the artifact-producing agent',
          row: true,
        }),
        supervisor: node({
          schema: optional(identity),
          title: 'Supervisor',
          description: 'Seat that delegated this work and receives its terminal signal',
          row: true,
          metadata: { 'x-public': 'strip-host' },
        }),
      }),
      title: 'Who',
      description: 'Identities accountable for producing and publishing this artifact',
    }),
    why: node({
      schema: Schema.Struct({
        mission: node({
          schema: optional(
            Schema.Struct({
              name: node({
                schema: Text,
                title: 'Mission name',
                description: 'Canonical owner-qualified mission subject',
              }),
              run: node({
                schema: optional(run),
                title: 'Mission run',
                description: 'Identifier of the mission execution containing this work',
                sensitivity: 'internal',
              }),
            }),
          ),
          title: 'Mission',
          description: 'Mission subject and execution that motivated this artifact',
          row: true,
          metadata: { 'x-format': 'join' },
        }),
        step: node({
          schema: optional(
            Schema.Struct({
              name: node({
                schema: Text,
                title: 'Step name',
                description: 'Named step within the artifact-producing mission',
              }),
              run: node({
                schema: optional(run),
                title: 'Step run',
                description: 'Identifier of the step execution that produced this artifact',
                sensitivity: 'internal',
              }),
            }),
          ),
          title: 'Step',
          description: 'Mission step and execution that produced this artifact',
          row: true,
          metadata: { 'x-format': 'join' },
        }),
      }).check(Schema.isMinProperties(1)),
      title: 'Why',
      description: 'Mission and step context motivating this artifact',
    }),
    how: node({
      schema: Schema.Struct({
        harness: node({
          schema: Schema.Struct({
            tool: node({
              schema: Text,
              title: 'Harness tool',
              description: 'Coding harness that produced this artifact',
            }),
            version: node({
              schema: optional(Text),
              title: 'Harness version',
              description: 'Observed release of the artifact-producing coding harness',
            }),
          }),
          title: 'Harness',
          description: 'Coding harness and its observed release for the producing session',
          row: true,
          metadata: { 'x-format': 'space' },
        }),
        model: node({
          schema: Schema.Struct({
            route: node({
              schema: ModelRoute,
              title: 'Model route',
              description: 'Observed provider-qualified model route used by the producing session',
            }),
            effort: node({
              schema: optional(Text),
              title: 'Model effort',
              description: 'Configured reasoning effort for the producing session',
              sensitivity: 'internal',
            }),
          }),
          title: 'Model',
          description: 'Provider-qualified model route and configured reasoning effort',
          row: true,
          metadata: { 'x-format': 'join' },
        }),
        tooling_profile: node({
          schema: optional(Text),
          title: 'Tooling profile',
          description: 'Dotfiles revision identifying the activated tooling configuration',
          sensitivity: 'internal',
          row: true,
        }),
        runtime_profile: node({
          schema: optional(Text),
          title: 'Runtime profile',
          description: 'Activated runtime configuration used by the producing session',
          sensitivity: 'internal',
          row: true,
        }),
        skills_manifest: node({
          schema: optional(Text),
          title: 'Skills manifest',
          description: 'Manifest identifying the skills available to the producing session',
          sensitivity: 'internal',
          row: true,
        }),
        invocation_id: node({
          schema: optional(Text),
          title: 'Invocation identifier',
          description: 'Identifier of the runtime invocation that produced this artifact',
          sensitivity: 'internal',
          row: true,
        }),
        issuance: node({
          schema: optional(
            Schema.Union([
              node({
                schema: Schema.Struct({
                  _tag: node({
                    schema: Schema.Literal('st-issued'),
                    title: 'Issuance kind',
                    description: 'Trace issued from a Smalltalk step execution',
                    sensitivity: 'internal',
                  }),
                  step_run: node({
                    schema: Text.check(
                      Schema.isPattern(/^step-run\/[0-9a-f]{32}\/[a-z0-9][a-z0-9._-]*$/u),
                    ),
                    title: 'Issuing step run',
                    description: 'Full Smalltalk step-run reference that issued this trace',
                    sensitivity: 'internal',
                  }),
                }),
                title: 'Smalltalk issuance',
                description: 'Trace issuance tied to a Smalltalk step-run authority',
                sensitivity: 'internal',
              }),
              node({
                schema: Schema.Struct({
                  _tag: node({
                    schema: Schema.Literal('not-st-issued'),
                    title: 'Issuance kind',
                    description: 'Trace issued outside a Smalltalk step execution',
                    sensitivity: 'internal',
                  }),
                  launcher: node({
                    schema: Text,
                    title: 'Issuing launcher',
                    description: 'Launcher responsible for issuance outside Smalltalk',
                    sensitivity: 'internal',
                  }),
                }),
                title: 'Launcher issuance',
                description: 'Trace issuance attributed to an external launcher',
                sensitivity: 'internal',
              }),
            ]),
          ),
          title: 'Issuance',
          description: 'Private authority or launcher that issued this trace',
          sensitivity: 'internal',
        }),
      }),
      title: 'How',
      description: 'Harness, model and tooling configuration used to produce this artifact',
    }),
    where: node({
      schema: Schema.Struct({
        session: node({
          schema: optional(SessionLookup),
          title: 'Session lookup',
          description: 'Short lookup identifying the artifact-producing session',
          row: true,
          metadata: { 'x-public': 'short-session' },
        }),
        host: node({
          schema: optional(Text),
          title: 'Host',
          description: 'Capture host on which the artifact-producing session ran',
          sensitivity: 'internal',
          row: true,
        }),
        worktree: node({
          schema: optional(Text),
          title: 'Worktree',
          description: 'Repository-qualified worktree used by the artifact-producing session',
          sensitivity: 'internal',
          row: true,
        }),
      }),
      title: 'Where',
      description: 'Session lookup and execution topology for this artifact',
    }),
  }),
  title: 'Agent Trace',
  description: 'Accountability record for one artifact-producing event',
})
/** Semantic authority for one artifact-producing event; current writers require accountable identities, purpose and runtime facts. */
export type AgentTraceV2 = typeof AgentTraceV2.Type
/** Mutable private runtime-file authority, sampled only when an artifact event occurs.
 * An idle seat has no purpose; event envelope fields never belong in this file.
 */
export const AgentTraceRuntimeV1 = node({
  schema: Schema.Struct({
    type: node({
      schema: Schema.Literal('agent-trace-runtime/v1'),
      title: 'Runtime record type',
      description: 'Versioned identifier of the mutable private Agent Trace runtime file',
      sensitivity: 'internal',
    }),
    who: AgentTraceV2.fields.who,
    why: optional(AgentTraceV2.fields.why),
    how: AgentTraceV2.fields.how,
    where: AgentTraceV2.fields.where,
    bakeoffNote: node({
      schema: optional(Text),
      title: 'Bakeoff note',
      description: 'Optional note proving authority evolution across repository boundaries',
      sensitivity: 'internal',
    }),
  }),
  title: 'Agent Trace runtime',
  description: 'Private live identity, optional purpose, runtime configuration and issuance',
  sensitivity: 'internal',
})
export type AgentTraceRuntimeV1 = typeof AgentTraceRuntimeV1.Type
/** Frozen parse options rejecting excess properties at publication boundaries. */
export const strict = { onExcessProperty: 'error' } as const
/** Reads and validates the metadata required for lowering and human rendering. */
export const annotations = (ast: AST.AST) => {
  const a = Schema.resolveAnnotationsKey(Schema.make(ast))
  if (!a?.title?.trim() || !a.description?.trim() || !a['x-sensitivity'])
    throw new TypeError('Schema node lacks title, description or sensitivity')
  for (const key of Object.keys(a))
    if (key.startsWith('x-') && !['x-sensitivity', 'x-row', 'x-format', 'x-public'].includes(key))
      throw new TypeError(`Unknown annotation ${key}`)
  if (!['public', 'internal', 'restricted', 'secret'].includes(a['x-sensitivity']))
    throw new TypeError('Unknown sensitivity')
  if (
    a['x-public'] !== undefined &&
    a['x-public'] !== 'short-session' &&
    a['x-public'] !== 'strip-host'
  )
    throw new TypeError('Unknown declarative publication rule')
  return a
}
/** Rejects a semantic node missing title, description or sensitivity metadata. */
export const auditAnnotations = (ast: AST.AST): void => {
  walkSchema({
    schema: Schema.make(ast),
    onNode: ({ ast: nested }) => {
      // Every semantic node owns its metadata; container annotations cannot
      // hide an unannotated array element or union arm.
      annotations(nested)
    },
  })
}
/** Enumerates the semantic leaf paths used to make medium bindings total. */
export const leafPaths = ({ ast, path = '' }: { ast: AST.AST; path?: string }): string[] =>
  AST.isObjects(ast)
    ? ast.propertySignatures.flatMap((p) =>
        leafPaths({ ast: p.type, path: path ? `${path}.${String(p.name)}` : String(p.name) }),
      )
    : [path]
