import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { Command, Options } from '@effect/cli'
import { Effect, Option } from 'effect'

import { runNetlifyDeploy } from './deploy-netlify.ts'
import { runVercelDeploy } from './deploy-vercel.ts'
import {
  collectWorkflowReportBundle,
  decodeWorkflowReportBundleJson,
  deriveWorkflowReportManagedState,
  encodeWorkflowReportBundleJson,
  extractWorkflowReportManagedState,
  findWorkflowReportManagedComment,
  renderWorkflowReportCommentBody,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportManagedComment,
} from './mod.ts'

const nonEmptyTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.text(opts.name).pipe(Options.withDescription(opts.description))

const optionalTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.text(opts.name).pipe(Options.withDescription(opts.description), Options.withDefault(''))

const expectString = (opts: { readonly value: unknown; readonly path: string }) => {
  if (typeof opts.value !== 'string' || opts.value.length === 0) {
    throw new Error(`${opts.path} must be a non-empty string`)
  }
  return opts.value
}

const optionalString = (value: string) => (value.length === 0 ? undefined : value)

const optionToUndefined = <A>(value: Option.Option<A>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (inner) => inner,
  })

const readComments = (path: string): readonly WorkflowReportManagedComment[] => {
  const comments = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (Array.isArray(comments) === false) throw new Error('comments response must be an array')
  return comments as readonly WorkflowReportManagedComment[]
}

const readInputPaths = (inputPathsJson: string) => {
  const inputPaths = JSON.parse(inputPathsJson) as unknown
  if (Array.isArray(inputPaths) === false) {
    throw new Error('input paths JSON must decode to an array')
  }
  return inputPaths.map((path, index) =>
    expectString({ value: path, path: `inputPaths[${index}]` }),
  )
}

const latestCreatedAtUtc = (opts: {
  readonly records: readonly { readonly createdAtUtc: string }[]
  readonly fallback: string
}) =>
  opts.records.reduce(
    (latest, record) => (record.createdAtUtc > latest ? record.createdAtUtc : latest),
    opts.fallback,
  )

const visibleWorkflowReportBody = (opts: { readonly body: string; readonly marker: string }) => {
  const markerIndex = opts.body.indexOf(opts.marker)
  return markerIndex === -1 ? opts.body : `${opts.body.slice(0, markerIndex).trimEnd()}\n`
}

const writeTextFile = (opts: { readonly path: string; readonly text: string }) => {
  mkdirSync(dirname(opts.path), { recursive: true })
  writeFileSync(opts.path, opts.text)
}

const collectBundleCommand = Command.make(
  'collect-bundle',
  {
    bundleId: nonEmptyTextOption({
      name: 'bundle-id',
      description: 'Workflow report bundle identifier',
    }),
    inputPathsJson: nonEmptyTextOption({
      name: 'input-paths-json',
      description: 'JSON array of marked JSONL input file paths',
    }),
    outputPath: nonEmptyTextOption({
      name: 'output-path',
      description: 'Path that receives the encoded bundle JSON',
    }),
    recordMarker: Options.text('record-marker').pipe(
      Options.withDescription('Line marker prefix for workflow report records'),
      Options.withDefault(workflowReportRecordLineMarker),
    ),
    allowMissingInput: Options.boolean('allow-missing-input').pipe(
      Options.withDescription('Ignore missing input files'),
      Options.withDefault(false),
    ),
  },
  ({ bundleId, inputPathsJson, outputPath, recordMarker, allowMissingInput }) =>
    Effect.sync(() => {
      const sources = []
      for (const path of readInputPaths(inputPathsJson)) {
        if (existsSync(path) === false) {
          if (allowMissingInput === true) continue
          throw new Error(`workflow report input file does not exist: ${path}`)
        }
        sources.push(readFileSync(path, 'utf8'))
      }

      const bundle = collectWorkflowReportBundle({
        bundleId,
        generatedAtUtc: new Date().toISOString(),
        sources,
        marker: recordMarker,
      })
      writeTextFile({ path: outputPath, text: encodeWorkflowReportBundleJson(bundle) })
    }),
).pipe(Command.withDescription('Collect marked workflow report records into a bundle'))

const renderCommentBodyCommand = Command.make(
  'render-comment-body',
  {
    bundlePath: nonEmptyTextOption({
      name: 'bundle-path',
      description: 'Path to a workflow report bundle JSON file',
    }),
    commentsPath: nonEmptyTextOption({
      name: 'comments-path',
      description: 'Path to a GitHub issue comments JSON array',
    }),
    commentBodyPath: nonEmptyTextOption({
      name: 'comment-body-path',
      description: 'Path that receives the full managed comment body',
    }),
    summaryPath: nonEmptyTextOption({
      name: 'summary-path',
      description: 'Path that receives the visible summary body',
    }),
    title: nonEmptyTextOption({
      name: 'title',
      description: 'Markdown title for the report comment',
    }),
    noRecordsMessage: nonEmptyTextOption({
      name: 'no-records-message',
      description: 'Message rendered when the report bundle has no records',
    }),
    stateId: nonEmptyTextOption({
      name: 'state-id',
      description: 'Stable managed state identifier',
    }),
    entryId: nonEmptyTextOption({
      name: 'entry-id',
      description: 'Current report history entry identifier',
    }),
    entryLabel: nonEmptyTextOption({
      name: 'entry-label',
      description: 'Current report history entry label',
    }),
    createdAtUtc: optionalTextOption({
      name: 'created-at-utc',
      description: 'Current report history entry timestamp, defaults to latest record timestamp',
    }),
    timeZone: Options.text('time-zone').pipe(
      Options.withDescription('IANA time zone for rendered timestamps'),
      Options.withDefault('UTC'),
    ),
    managedMarker: Options.text('managed-marker').pipe(
      Options.withDescription('Managed comment marker'),
      Options.withDefault(workflowReportManagedMarker),
    ),
  },
  ({
    bundlePath,
    commentsPath,
    commentBodyPath,
    summaryPath,
    title,
    noRecordsMessage,
    stateId,
    entryId,
    entryLabel,
    createdAtUtc,
    timeZone,
    managedMarker,
  }) =>
    Effect.sync(() => {
      const bundle = decodeWorkflowReportBundleJson(readFileSync(bundlePath, 'utf8'))
      const comments = readComments(commentsPath)
      const existingComment = findWorkflowReportManagedComment(comments, {
        stateId,
        marker: managedMarker,
      })
      const state = deriveWorkflowReportManagedState({
        stateId,
        timeZone,
        ...(existingComment === undefined ? {} : { priorState: existingComment.state }),
        entryId,
        entryLabel,
        createdAtUtc:
          optionalString(createdAtUtc) ??
          latestCreatedAtUtc({ records: bundle.records, fallback: bundle.generatedAtUtc }),
        records: bundle.records,
      })
      const body = renderWorkflowReportCommentBody({ title, noRecordsMessage, state })

      writeTextFile({ path: commentBodyPath, text: body })
      writeTextFile({
        path: summaryPath,
        text: visibleWorkflowReportBody({ body, marker: managedMarker }),
      })
    }),
).pipe(Command.withDescription('Render a managed workflow report comment body'))

const findCommentCommand = Command.make(
  'find-comment',
  {
    commentsPath: nonEmptyTextOption({
      name: 'comments-path',
      description: 'Path to a GitHub issue comments JSON array',
    }),
    commentBodyPath: nonEmptyTextOption({
      name: 'comment-body-path',
      description: 'Path to the target comment body',
    }),
    commentIdPath: nonEmptyTextOption({
      name: 'comment-id-path',
      description: 'Path that receives the existing managed comment id, or an empty string',
    }),
    stateId: nonEmptyTextOption({
      name: 'state-id',
      description: 'Stable managed state identifier',
    }),
    managedMarker: Options.text('managed-marker').pipe(
      Options.withDescription('Managed comment marker'),
      Options.withDefault(workflowReportManagedMarker),
    ),
  },
  ({ commentsPath, commentBodyPath, commentIdPath, stateId, managedMarker }) =>
    Effect.sync(() => {
      const targetState = extractWorkflowReportManagedState(readFileSync(commentBodyPath, 'utf8'), {
        stateId,
      })
      if (targetState === undefined) {
        throw new Error('workflow report comment body is missing managed state')
      }
      const existingComment = findWorkflowReportManagedComment(readComments(commentsPath), {
        stateId: targetState.stateId,
        marker: managedMarker,
      })
      writeTextFile({ path: commentIdPath, text: existingComment?.id ?? '' })
    }),
).pipe(Command.withDescription('Find the existing managed workflow report comment'))

const netlifyDeployCommand = Command.make(
  'netlify',
  {
    target: nonEmptyTextOption({
      name: 'target',
      description: 'Stable deploy target name',
    }),
    artifactDir: nonEmptyTextOption({
      name: 'artifact-dir',
      description: 'Local static directory to deploy',
    }),
    mode: Options.choice('mode', ['prod', 'pr', 'draft']).pipe(
      Options.withDescription('Netlify deploy mode'),
      Options.withDefault('draft' as const),
    ),
    displayName: Options.text('display-name').pipe(
      Options.withDescription('Human-readable deploy target label'),
      Options.optional,
    ),
    pr: Options.integer('pr').pipe(
      Options.withDescription('Pull request number for PR deploy mode'),
      Options.optional,
    ),
    siteName: Options.text('site-name').pipe(
      Options.withDescription('Netlify site slug used for final alias URLs'),
      Options.optional,
    ),
    siteIdEnv: Options.text('site-id-env').pipe(
      Options.withDescription('Environment variable containing the Netlify site id'),
      Options.withDefault('NETLIFY_SITE_ID'),
    ),
    authTokenEnv: Options.text('auth-token-env').pipe(
      Options.withDescription('Environment variable containing the Netlify auth token'),
      Options.withDefault('NETLIFY_AUTH_TOKEN'),
    ),
    accountSlugEnv: Options.text('account-slug-env').pipe(
      Options.withDescription('Optional environment variable containing the Netlify account slug'),
      Options.optional,
    ),
    workspaceFilter: Options.text('workspace-filter').pipe(
      Options.withDescription('Optional Netlify monorepo workspace filter passed to the CLI'),
      Options.optional,
    ),
    workflowReportOutputFile: Options.text('workflow-report-output-file').pipe(
      Options.withDescription('Optional JSONL file that receives marked workflow-report records'),
      Options.optional,
    ),
    githubOutputFile: Options.text('github-output-file').pipe(
      Options.withDescription('Optional GitHub Actions output file that receives deploy outputs'),
      Options.optional,
    ),
    githubEnvFile: Options.text('github-env-file').pipe(
      Options.withDescription('Optional GitHub Actions env file that receives deploy env vars'),
      Options.optional,
    ),
    urlEnvKey: Options.text('url-env-key').pipe(
      Options.withDescription('Optional env var name for the final deploy URL'),
      Options.optional,
    ),
    netlifyBin: Options.text('netlify-bin').pipe(
      Options.withDescription('Netlify CLI binary path'),
      Options.withDefault('netlify'),
    ),
    netlifyApiBaseUrl: Options.text('netlify-api-base-url').pipe(
      Options.withDescription('Netlify API base URL'),
      Options.withDefault('https://api.netlify.com'),
    ),
    missingAuthPolicy: Options.choice('missing-auth-policy', ['fail', 'skip']).pipe(
      Options.withDescription('Whether missing Netlify auth fails or emits a skipped record'),
      Options.withDefault('fail' as const),
    ),
    createdAtUtc: Options.text('created-at-utc').pipe(
      Options.withDescription('Override record creation timestamp for deterministic tests'),
      Options.optional,
    ),
    e2eAllowSharedProject: Options.boolean('e2e-allow-shared-project').pipe(
      Options.withDescription('Enable shared-project live E2E alias guardrails'),
      Options.withDefault(false),
    ),
    e2eReservedAliasPrefix: Options.text('e2e-reserved-alias-prefix').pipe(
      Options.withDescription('Required alias prefix when shared-project E2E is enabled'),
      Options.withDefault('ci-tools-e2e'),
    ),
    e2eVerifyPath: Options.text('e2e-verify-path').pipe(
      Options.withDescription('Optional live E2E path to fetch after deploy'),
      Options.optional,
    ),
    e2eVerifyText: Options.text('e2e-verify-text').pipe(
      Options.withDescription('Optional live E2E marker text expected at the verify path'),
      Options.optional,
    ),
  },
  (opts) =>
    runNetlifyDeploy({
      ...opts,
      displayName: optionToUndefined(opts.displayName),
      pr: optionToUndefined(opts.pr),
      siteName: optionToUndefined(opts.siteName),
      accountSlugEnv: optionToUndefined(opts.accountSlugEnv),
      workspaceFilter: optionToUndefined(opts.workspaceFilter),
      workflowReportOutputFile: optionToUndefined(opts.workflowReportOutputFile),
      githubOutputFile: optionToUndefined(opts.githubOutputFile),
      githubEnvFile: optionToUndefined(opts.githubEnvFile),
      urlEnvKey: optionToUndefined(opts.urlEnvKey),
      createdAtUtc: optionToUndefined(opts.createdAtUtc),
      e2eVerifyPath: optionToUndefined(opts.e2eVerifyPath),
      e2eVerifyText: optionToUndefined(opts.e2eVerifyText),
    }),
).pipe(Command.withDescription('Deploy a local static directory to Netlify'))

const vercelDeployCommand = Command.make(
  'vercel',
  {
    target: nonEmptyTextOption({
      name: 'target',
      description: 'Stable deploy target name',
    }),
    artifactDir: nonEmptyTextOption({
      name: 'artifact-dir',
      description: 'Local static directory to package and deploy as prebuilt Vercel output',
    }),
    artifactKind: Options.choice('artifact-kind', ['static', 'prebuilt-output']).pipe(
      Options.withDescription(
        'Whether artifact-dir is static files or a Vercel Build Output API directory',
      ),
      Options.withDefault('static' as const),
    ),
    mode: Options.choice('mode', ['prod', 'pr', 'preview']).pipe(
      Options.withDescription('Vercel deploy mode'),
      Options.withDefault('preview' as const),
    ),
    displayName: Options.text('display-name').pipe(
      Options.withDescription('Human-readable deploy target label'),
      Options.optional,
    ),
    pr: Options.integer('pr').pipe(
      Options.withDescription('Pull request number for PR deploy mode'),
      Options.optional,
    ),
    aliasPrefix: Options.text('alias-prefix').pipe(
      Options.withDescription('Optional Vercel alias prefix; defaults to target'),
      Options.optional,
    ),
    aliasSuffix: Options.text('alias-suffix').pipe(
      Options.withDescription('Optional suffix appended to Vercel aliases'),
      Options.optional,
    ),
    productionDomain: Options.text('production-domain').pipe(
      Options.withDescription('Production hostname to alias to the deployment (repeatable)'),
      Options.repeated,
    ),
    projectIdEnv: Options.text('project-id-env').pipe(
      Options.withDescription('Environment variable containing the Vercel project id'),
      Options.withDefault('VERCEL_PROJECT_ID'),
    ),
    orgIdEnv: Options.text('org-id-env').pipe(
      Options.withDescription('Environment variable containing the Vercel org/team id'),
      Options.withDefault('VERCEL_ORG_ID'),
    ),
    authTokenEnv: Options.text('auth-token-env').pipe(
      Options.withDescription('Environment variable containing the Vercel auth token'),
      Options.withDefault('VERCEL_TOKEN'),
    ),
    teamIdEnv: Options.text('team-id-env').pipe(
      Options.withDescription('Optional environment variable containing the Vercel team id'),
      Options.optional,
    ),
    scopeEnv: Options.text('scope-env').pipe(
      Options.withDescription('Optional environment variable containing the Vercel CLI scope slug'),
      Options.optional,
    ),
    protectionBypassEnv: Options.text('protection-bypass-env').pipe(
      Options.withDescription(
        'Optional environment variable containing the Vercel protection bypass secret for live verification',
      ),
      Options.optional,
    ),
    workflowReportOutputFile: Options.text('workflow-report-output-file').pipe(
      Options.withDescription('Optional JSONL file that receives marked workflow-report records'),
      Options.optional,
    ),
    githubOutputFile: Options.text('github-output-file').pipe(
      Options.withDescription('Optional GitHub Actions output file that receives deploy outputs'),
      Options.optional,
    ),
    githubEnvFile: Options.text('github-env-file').pipe(
      Options.withDescription('Optional GitHub Actions env file that receives deploy env vars'),
      Options.optional,
    ),
    urlEnvKey: Options.text('url-env-key').pipe(
      Options.withDescription('Optional env var name for the final deploy URL'),
      Options.optional,
    ),
    buildPrebuiltOutput: Options.boolean('build-prebuilt-output').pipe(
      Options.withDescription('Run vercel pull/build before deploying a prebuilt-output artifact'),
      Options.withDefault(false),
    ),
    vercelRootDirectory: Options.text('vercel-root-directory').pipe(
      Options.withDescription(
        'Optional Vercel project rootDirectory used while building prebuilt output',
      ),
      Options.optional,
    ),
    buildEnv: Options.text('build-env').pipe(
      Options.withDescription(
        'Environment variable for local vercel build (KEY=VALUE, repeatable)',
      ),
      Options.repeated,
    ),
    vercelBin: Options.text('vercel-bin').pipe(
      Options.withDescription('Vercel CLI binary path'),
      Options.withDefault('vercel'),
    ),
    vercelApiBaseUrl: Options.text('vercel-api-base-url').pipe(
      Options.withDescription('Vercel API base URL'),
      Options.withDefault('https://api.vercel.com'),
    ),
    createdAtUtc: Options.text('created-at-utc').pipe(
      Options.withDescription('Override record creation timestamp for deterministic tests'),
      Options.optional,
    ),
    e2eAllowSharedProject: Options.boolean('e2e-allow-shared-project').pipe(
      Options.withDescription('Enable shared-project live E2E alias guardrails'),
      Options.withDefault(false),
    ),
    e2eReservedAliasPrefix: Options.text('e2e-reserved-alias-prefix').pipe(
      Options.withDescription('Required alias prefix when shared-project E2E is enabled'),
      Options.withDefault('ci-tools-e2e'),
    ),
    e2eVerifyPath: Options.text('e2e-verify-path').pipe(
      Options.withDescription('Optional live E2E path to fetch after deploy'),
      Options.optional,
    ),
    e2eVerifyText: Options.text('e2e-verify-text').pipe(
      Options.withDescription('Optional live E2E marker text expected at the verify path'),
      Options.optional,
    ),
  },
  (opts) =>
    runVercelDeploy({
      ...opts,
      displayName: optionToUndefined(opts.displayName),
      pr: optionToUndefined(opts.pr),
      artifactKind: opts.artifactKind,
      aliasPrefix: optionToUndefined(opts.aliasPrefix),
      aliasSuffix: optionToUndefined(opts.aliasSuffix),
      productionDomains: opts.productionDomain,
      teamIdEnv: optionToUndefined(opts.teamIdEnv),
      scopeEnv: optionToUndefined(opts.scopeEnv),
      protectionBypassEnv: optionToUndefined(opts.protectionBypassEnv),
      workflowReportOutputFile: optionToUndefined(opts.workflowReportOutputFile),
      githubOutputFile: optionToUndefined(opts.githubOutputFile),
      githubEnvFile: optionToUndefined(opts.githubEnvFile),
      urlEnvKey: optionToUndefined(opts.urlEnvKey),
      buildPrebuiltOutput: opts.buildPrebuiltOutput,
      vercelRootDirectory: optionToUndefined(opts.vercelRootDirectory),
      buildEnv: opts.buildEnv,
      createdAtUtc: optionToUndefined(opts.createdAtUtc),
      e2eVerifyPath: optionToUndefined(opts.e2eVerifyPath),
      e2eVerifyText: optionToUndefined(opts.e2eVerifyText),
    }),
).pipe(Command.withDescription('Deploy a local static directory to Vercel'))

/** CLI command for deploy preview provider operations. */
export const deployCommand = Command.make('deploy').pipe(
  Command.withSubcommands([netlifyDeployCommand, vercelDeployCommand]),
  Command.withDescription('Deploy preview provider operations'),
)

/** CLI command for collecting bundles and rendering managed workflow report comments. */
export const workflowReportCommand = Command.make('workflow-report').pipe(
  Command.withSubcommands([collectBundleCommand, renderCommentBodyCommand, findCommentCommand]),
  Command.withDescription('Workflow report bundle, render, and comment-state helpers'),
)

/** Root CLI command for CI automation helpers. */
export const ciToolsCommand = Command.make('ci-tools').pipe(
  Command.withSubcommands([workflowReportCommand, deployCommand]),
  Command.withDescription('CI automation helpers'),
)
