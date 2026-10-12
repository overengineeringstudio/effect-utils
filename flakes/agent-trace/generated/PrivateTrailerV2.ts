// Generated; do not edit. Inputs: src/schema.ts, src/bindings.ts, src/projection.ts, src/generator.ts, src/registry.ts, ../schema-registry/rust/Cargo.toml, ../schema-registry/rust/src/lib.rs, ../schema-registry/rust/src/numbers.rs, ../schema-registry/rust/src/runtime.rs, ../schema-registry/rust/src/bin/schema-registry-rust.rs, rust/Cargo.lock, package.json, ../../.oxfmtrc.json; Effect 4.0.0.
// Regenerate: pnpm run generate; sha256=dd1d1e63431851ad32ccc8913860f8aa8bb432d503953d82c9810603e7ce1ca6
import { Schema } from 'effect'

import type { Plan } from '../src/projection.ts'
/** Generated private-rich trailer/v2 view of agent-trace/v2. */
export const PrivateTrailerV2 = Schema.Struct({
  type: Schema.Literal('agent-trace/v2').annotateKey({
    title: 'Record type',
    description: 'Versioned identifier of the semantic Agent Trace record',
    'x-sensitivity': 'public',
    'x-row': false,
  }),
  who: Schema.Struct({
    agent: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        )
        .check(
          Schema.isPattern(
            new RegExp(
              '^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$',
              'u',
            ),
          ).annotate({
            expected:
              'a string matching the RegExp ^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$',
          }),
        ),
    ).annotateKey({
      title: 'Agent',
      description: 'Seat or direct-session identity responsible for producing this artifact',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-public': 'strip-host',
    }),
    principal: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Accountable human',
      description: 'Human principal on whose behalf the artifact was produced',
      'x-sensitivity': 'public',
      'x-row': true,
    }),
    actor: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'GitHub actor',
      description: 'GitHub account authenticated to publish this artifact',
      'x-sensitivity': 'public',
      'x-row': true,
    }),
    persona: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Persona',
      description: 'Behavioral persona used by the artifact-producing agent',
      'x-sensitivity': 'public',
      'x-row': true,
    }),
    supervisor: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        )
        .check(
          Schema.isPattern(
            new RegExp(
              '^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$',
              'u',
            ),
          ).annotate({
            expected:
              'a string matching the RegExp ^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$',
          }),
        ),
    ).annotateKey({
      title: 'Supervisor',
      description: 'Seat that delegated this work and receives its terminal signal',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-public': 'strip-host',
    }),
  }).annotateKey({
    title: 'Who',
    description: 'Identities accountable for producing and publishing this artifact',
    'x-sensitivity': 'public',
    'x-row': false,
  }),
  why: Schema.Struct({
    mission: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String.check(
          Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
        )
          .check(
            Schema.isTrimmed().annotate({
              expected: 'a string with no leading or trailing whitespace',
            }),
          )
          .check(
            Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
              expected: 'a string matching the RegExp ^[^\\r\\n]+$',
            }),
          )
          .annotateKey({
            title: 'Mission name',
            description: 'Canonical owner-qualified mission subject',
            'x-sensitivity': 'public',
            'x-row': false,
          }),
        run: Schema.optionalKey(
          Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[0-9a-f]{32}$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[0-9a-f]{32}$',
              }),
            ),
        ).annotateKey({
          title: 'Mission run',
          description: 'Identifier of the mission execution containing this work',
          'x-sensitivity': 'internal',
          'x-row': false,
        }),
      }),
    ).annotateKey({
      title: 'Mission',
      description: 'Mission subject and execution that motivated this artifact',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-format': 'join',
    }),
    step: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String.check(
          Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
        )
          .check(
            Schema.isTrimmed().annotate({
              expected: 'a string with no leading or trailing whitespace',
            }),
          )
          .check(
            Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
              expected: 'a string matching the RegExp ^[^\\r\\n]+$',
            }),
          )
          .annotateKey({
            title: 'Step name',
            description: 'Named step within the artifact-producing mission',
            'x-sensitivity': 'public',
            'x-row': false,
          }),
        run: Schema.optionalKey(
          Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[0-9a-f]{32}$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[0-9a-f]{32}$',
              }),
            ),
        ).annotateKey({
          title: 'Step run',
          description: 'Identifier of the step execution that produced this artifact',
          'x-sensitivity': 'internal',
          'x-row': false,
        }),
      }),
    ).annotateKey({
      title: 'Step',
      description: 'Mission step and execution that produced this artifact',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-format': 'join',
    }),
  }).annotateKey({
    title: 'Why',
    description: 'Mission and step context motivating this artifact',
    'x-sensitivity': 'public',
    'x-row': false,
  }),
  how: Schema.Struct({
    harness: Schema.optionalKey(
      Schema.Struct({
        tool: Schema.String.check(
          Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
        )
          .check(
            Schema.isTrimmed().annotate({
              expected: 'a string with no leading or trailing whitespace',
            }),
          )
          .check(
            Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
              expected: 'a string matching the RegExp ^[^\\r\\n]+$',
            }),
          )
          .annotateKey({
            title: 'Harness tool',
            description: 'Coding harness that produced this artifact',
            'x-sensitivity': 'public',
            'x-row': false,
          }),
        version: Schema.optionalKey(
          Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            ),
        ).annotateKey({
          title: 'Harness version',
          description: 'Observed release of the artifact-producing coding harness',
          'x-sensitivity': 'public',
          'x-row': false,
        }),
      }),
    ).annotateKey({
      title: 'Harness',
      description: 'Coding harness and its observed release for the producing session',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-format': 'space',
    }),
    model: Schema.optionalKey(
      Schema.Struct({
        route: Schema.String.check(
          Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
        )
          .check(
            Schema.isTrimmed().annotate({
              expected: 'a string with no leading or trailing whitespace',
            }),
          )
          .check(
            Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
              expected: 'a string matching the RegExp ^[^\\r\\n]+$',
            }),
          )
          .check(
            Schema.isMaxLength(64).annotate({ expected: 'a value with a length of at most 64' }),
          )
          .check(
            Schema.isPattern(
              new RegExp('^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$', 'u'),
            ).annotate({
              expected:
                'a string matching the RegExp ^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$',
            }),
          )
          .annotateKey({
            title: 'Model route',
            description: 'Observed provider-qualified model route used by the producing session',
            'x-sensitivity': 'public',
            'x-row': false,
          }),
        effort: Schema.optionalKey(
          Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            ),
        ).annotateKey({
          title: 'Model effort',
          description: 'Configured reasoning effort for the producing session',
          'x-sensitivity': 'internal',
          'x-row': false,
        }),
      }),
    ).annotateKey({
      title: 'Model',
      description: 'Provider-qualified model route and configured reasoning effort',
      'x-sensitivity': 'public',
      'x-row': true,
      'x-format': 'join',
    }),
    tooling_profile: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Tooling profile',
      description: 'Dotfiles revision identifying the activated tooling configuration',
      'x-sensitivity': 'internal',
      'x-row': true,
    }),
    runtime_profile: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Runtime profile',
      description: 'Activated runtime configuration used by the producing session',
      'x-sensitivity': 'internal',
      'x-row': true,
    }),
    skills_manifest: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Skills manifest',
      description: 'Manifest identifying the skills available to the producing session',
      'x-sensitivity': 'internal',
      'x-row': true,
    }),
    invocation_id: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
      )
        .check(
          Schema.isTrimmed().annotate({
            expected: 'a string with no leading or trailing whitespace',
          }),
        )
        .check(
          Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
            expected: 'a string matching the RegExp ^[^\\r\\n]+$',
          }),
        ),
    ).annotateKey({
      title: 'Invocation identifier',
      description: 'Identifier of the runtime invocation that produced this artifact',
      'x-sensitivity': 'internal',
      'x-row': true,
    }),
    issuance: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({
          _tag: Schema.Literal('st-issued').annotateKey({
            title: 'Issuance kind',
            description: 'Trace issued from a Smalltalk step execution',
            'x-sensitivity': 'internal',
            'x-row': false,
          }),
          step_run: Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            )
            .check(
              Schema.isPattern(
                new RegExp('^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$', 'u'),
              ).annotate({
                expected:
                  'a string matching the RegExp ^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$',
              }),
            )
            .annotateKey({
              title: 'Issuing step run',
              description: 'Full Smalltalk step-run reference that issued this trace',
              'x-sensitivity': 'internal',
              'x-row': false,
            }),
        }),
        Schema.Struct({
          _tag: Schema.Literal('not-st-issued').annotateKey({
            title: 'Issuance kind',
            description: 'Trace issued outside a Smalltalk step execution',
            'x-sensitivity': 'internal',
            'x-row': false,
          }),
          launcher: Schema.String.check(
            Schema.isMinLength(1).annotate({ expected: 'a value with a length of at least 1' }),
          )
            .check(
              Schema.isTrimmed().annotate({
                expected: 'a string with no leading or trailing whitespace',
              }),
            )
            .check(
              Schema.isPattern(new RegExp('^[^\\r\\n]+$', 'u')).annotate({
                expected: 'a string matching the RegExp ^[^\\r\\n]+$',
              }),
            )
            .annotateKey({
              title: 'Issuing launcher',
              description: 'Launcher responsible for issuance outside Smalltalk',
              'x-sensitivity': 'internal',
              'x-row': false,
            }),
        }),
      ]),
    ).annotateKey({
      title: 'Issuance',
      description: 'Private authority or launcher that issued this trace',
      'x-sensitivity': 'internal',
      'x-row': false,
    }),
  }).annotateKey({
    title: 'How',
    description: 'Harness, model and tooling configuration used to produce this artifact',
    'x-sensitivity': 'public',
    'x-row': false,
  }),
}).pipe(Schema.brand('PrivateTrailerV2'))
/** Decoded branded type of the generated view. */
export type PrivateTrailerV2 = typeof PrivateTrailerV2.Type
/** Generated portable coarsening and restriction plan. */
export const plan = {
  kind: 'object',
  fields: {
    type: { kind: 'leaf' },
    who: {
      kind: 'object',
      fields: {
        agent: { kind: 'leaf' },
        principal: { kind: 'leaf' },
        actor: { kind: 'leaf' },
        persona: { kind: 'leaf' },
        supervisor: { kind: 'leaf' },
      },
    },
    why: {
      kind: 'object',
      fields: {
        mission: { kind: 'object', fields: { name: { kind: 'leaf' }, run: { kind: 'leaf' } } },
        step: { kind: 'object', fields: { name: { kind: 'leaf' }, run: { kind: 'leaf' } } },
      },
    },
    how: {
      kind: 'object',
      fields: {
        harness: { kind: 'object', fields: { tool: { kind: 'leaf' }, version: { kind: 'leaf' } } },
        model: { kind: 'object', fields: { route: { kind: 'leaf' }, effort: { kind: 'leaf' } } },
        tooling_profile: { kind: 'leaf' },
        runtime_profile: { kind: 'leaf' },
        skills_manifest: { kind: 'leaf' },
        invocation_id: { kind: 'leaf' },
        issuance: { kind: 'leaf' },
      },
    },
  },
} satisfies Plan
