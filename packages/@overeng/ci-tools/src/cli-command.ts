/* oxlint-disable overeng/exports-first -- Public command trees must be assembled after their private leaf commands are initialized. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { Command, Flag as Options } from 'effect/unstable/cli'
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
import {
  decodeQuarantineLedgerJson,
  expiredQuarantineEntries,
  renderQuarantineAnnotation,
  renderQuarantineAnnouncement,
  renderQuarantineSummaryLine,
  resolveQuarantineEntry,
} from './quarantine.ts'

const nonEmptyTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.string(opts.name).pipe(Options.withDescription(opts.description))

const optionalTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.string(opts.name).pipe(Options.withDescription(opts.description), Options.withDefault(''))

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
  return inputPaths.map((path, index) => {
    if (typeof path !== 'string') throw new Error(`inputPaths[${index}] must be a string`)
    return path
  })
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
    recordMarker: Options.string('record-marker').pipe(
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
        if (path.length === 0 || existsSync(path) === false) {
          if (allowMissingInput === true) continue
          if (path.length === 0) throw new Error('workflow report input path must be non-empty')
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
    timeZone: Options.string('time-zone').pipe(
      Options.withDescription('IANA time zone for rendered timestamps'),
      Options.withDefault('UTC'),
    ),
    managedMarker: Options.string('managed-marker').pipe(
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
    managedMarker: Options.string('managed-marker').pipe(
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
    displayName: Options.string('display-name').pipe(
      Options.withDescription('Human-readable deploy target label'),
      Options.optional,
    ),
    pr: Options.integer('pr').pipe(
      Options.withDescription('Pull request number for PR deploy mode'),
      Options.optional,
    ),
    siteName: Options.string('site-name').pipe(
      Options.withDescription('Netlify site slug used for final alias URLs'),
      Options.optional,
    ),
    siteIdEnv: Options.string('site-id-env').pipe(
      Options.withDescription('Environment variable containing the Netlify site id'),
      Options.withDefault('NETLIFY_SITE_ID'),
    ),
    authTokenEnv: Options.string('auth-token-env').pipe(
      Options.withDescription('Environment variable containing the Netlify auth token'),
      Options.withDefault('NETLIFY_AUTH_TOKEN'),
    ),
    accountSlugEnv: Options.string('account-slug-env').pipe(
      Options.withDescription('Optional environment variable containing the Netlify account slug'),
      Options.optional,
    ),
    workspaceFilter: Options.string('workspace-filter').pipe(
      Options.withDescription('Optional Netlify monorepo workspace filter passed to the CLI'),
      Options.optional,
    ),
    workflowReportOutputFile: Options.string('workflow-report-output-file').pipe(
      Options.withDescription('Optional JSONL file that receives marked workflow-report records'),
      Options.optional,
    ),
    githubOutputFile: Options.string('github-output-file').pipe(
      Options.withDescription('Optional GitHub Actions output file that receives deploy outputs'),
      Options.optional,
    ),
    githubEnvFile: Options.string('github-env-file').pipe(
      Options.withDescription('Optional GitHub Actions env file that receives deploy env vars'),
      Options.optional,
    ),
    urlEnvKey: Options.string('url-env-key').pipe(
      Options.withDescription('Optional env var name for the final deploy URL'),
      Options.optional,
    ),
    netlifyBin: Options.string('netlify-bin').pipe(
      Options.withDescription('Netlify CLI binary path'),
      Options.withDefault('netlify'),
    ),
    netlifyApiBaseUrl: Options.string('netlify-api-base-url').pipe(
      Options.withDescription('Netlify API base URL'),
      Options.withDefault('https://api.netlify.com'),
    ),
    missingAuthPolicy: Options.choice('missing-auth-policy', ['fail', 'skip']).pipe(
      Options.withDescription('Whether missing Netlify auth fails or emits a skipped record'),
      Options.withDefault('fail' as const),
    ),
    unauthorizedPolicy: Options.choice('unauthorized-policy', ['fail', 'skip']).pipe(
      Options.withDescription(
        'Whether unauthorized Netlify credentials fail or emit a skipped record',
      ),
      Options.withDefault('fail' as const),
    ),
    createdAtUtc: Options.string('created-at-utc').pipe(
      Options.withDescription('Override record creation timestamp for deterministic tests'),
      Options.optional,
    ),
    e2eAllowSharedProject: Options.boolean('e2e-allow-shared-project').pipe(
      Options.withDescription('Enable shared-project live E2E alias guardrails'),
      Options.withDefault(false),
    ),
    e2eReservedAliasPrefix: Options.string('e2e-reserved-alias-prefix').pipe(
      Options.withDescription('Required alias prefix when shared-project E2E is enabled'),
      Options.withDefault('ci-tools-e2e'),
    ),
    e2eVerifyPath: Options.string('e2e-verify-path').pipe(
      Options.withDescription('Optional live E2E path to fetch after deploy'),
      Options.optional,
    ),
    e2eVerifyText: Options.string('e2e-verify-text').pipe(
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
    displayName: Options.string('display-name').pipe(
      Options.withDescription('Human-readable deploy target label'),
      Options.optional,
    ),
    pr: Options.integer('pr').pipe(
      Options.withDescription('Pull request number for PR deploy mode'),
      Options.optional,
    ),
    aliasPrefix: Options.string('alias-prefix').pipe(
      Options.withDescription('Optional Vercel alias prefix; defaults to target'),
      Options.optional,
    ),
    aliasSuffix: Options.string('alias-suffix').pipe(
      Options.withDescription('Optional suffix appended to Vercel aliases'),
      Options.optional,
    ),
    productionDomain: Options.string('production-domain').pipe(
      Options.withDescription('Production hostname to alias to the deployment (repeatable)'),
      Options.atLeast(1),
    ),
    projectIdEnv: Options.string('project-id-env').pipe(
      Options.withDescription('Environment variable containing the Vercel project id'),
      Options.withDefault('VERCEL_PROJECT_ID'),
    ),
    orgIdEnv: Options.string('org-id-env').pipe(
      Options.withDescription('Environment variable containing the Vercel org/team id'),
      Options.withDefault('VERCEL_ORG_ID'),
    ),
    authTokenEnv: Options.string('auth-token-env').pipe(
      Options.withDescription('Environment variable containing the Vercel auth token'),
      Options.withDefault('VERCEL_TOKEN'),
    ),
    teamIdEnv: Options.string('team-id-env').pipe(
      Options.withDescription('Optional environment variable containing the Vercel team id'),
      Options.optional,
    ),
    scopeEnv: Options.string('scope-env').pipe(
      Options.withDescription('Optional environment variable containing the Vercel CLI scope slug'),
      Options.optional,
    ),
    protectionBypassEnv: Options.string('protection-bypass-env').pipe(
      Options.withDescription(
        'Optional environment variable containing the Vercel protection bypass secret for live verification',
      ),
      Options.optional,
    ),
    workflowReportOutputFile: Options.string('workflow-report-output-file').pipe(
      Options.withDescription('Optional JSONL file that receives marked workflow-report records'),
      Options.optional,
    ),
    githubOutputFile: Options.string('github-output-file').pipe(
      Options.withDescription('Optional GitHub Actions output file that receives deploy outputs'),
      Options.optional,
    ),
    githubEnvFile: Options.string('github-env-file').pipe(
      Options.withDescription('Optional GitHub Actions env file that receives deploy env vars'),
      Options.optional,
    ),
    urlEnvKey: Options.string('url-env-key').pipe(
      Options.withDescription('Optional env var name for the final deploy URL'),
      Options.optional,
    ),
    buildPrebuiltOutput: Options.boolean('build-prebuilt-output').pipe(
      Options.withDescription('Run vercel pull/build before deploying a prebuilt-output artifact'),
      Options.withDefault(false),
    ),
    vercelRootDirectory: Options.string('vercel-root-directory').pipe(
      Options.withDescription(
        'Optional Vercel project rootDirectory used while building prebuilt output',
      ),
      Options.optional,
    ),
    buildEnv: Options.string('build-env').pipe(
      Options.withDescription(
        'Environment variable for local vercel build (KEY=VALUE, repeatable)',
      ),
      Options.atLeast(1),
    ),
    vercelBin: Options.string('vercel-bin').pipe(
      Options.withDescription('Vercel CLI binary path'),
      Options.withDefault('vercel'),
    ),
    vercelApiBaseUrl: Options.string('vercel-api-base-url').pipe(
      Options.withDescription('Vercel API base URL'),
      Options.withDefault('https://api.vercel.com'),
    ),
    createdAtUtc: Options.string('created-at-utc').pipe(
      Options.withDescription('Override record creation timestamp for deterministic tests'),
      Options.optional,
    ),
    e2eAllowSharedProject: Options.boolean('e2e-allow-shared-project').pipe(
      Options.withDescription('Enable shared-project live E2E alias guardrails'),
      Options.withDefault(false),
    ),
    e2eReservedAliasPrefix: Options.string('e2e-reserved-alias-prefix').pipe(
      Options.withDescription('Required alias prefix when shared-project E2E is enabled'),
      Options.withDefault('ci-tools-e2e'),
    ),
    e2eVerifyPath: Options.string('e2e-verify-path').pipe(
      Options.withDescription('Optional live E2E path to fetch after deploy'),
      Options.optional,
    ),
    e2eVerifyText: Options.string('e2e-verify-text').pipe(
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

const readLedger = (path: string) => {
  if (existsSync(path) === false) throw new Error(`quarantine ledger does not exist: ${path}`)
  return decodeQuarantineLedgerJson(readFileSync(path, 'utf8'))
}

const quarantineValidateCommand = Command.make(
  'validate',
  {
    ledger: nonEmptyTextOption({
      name: 'ledger',
      description: 'Path to the quarantine ledger JSON',
    }),
    today: Options.string('today').pipe(
      Options.withDescription(
        'Evaluate expiry against this YYYY-MM-DD date instead of the current day',
      ),
      Options.withDefault(''),
    ),
  },
  ({ ledger, today }) =>
    Effect.sync(() => {
      const expired = expiredQuarantineEntries({
        ledger: readLedger(ledger),
        today: optionalString(today) ?? new Date().toISOString().slice(0, 10),
      })

      if (expired.length === 0) return

      const detail = expired
        .map(
          ([key, entry]) => `  ${key} (${entry.target}) expired ${entry.expires} — ${entry.issue}`,
        )
        .join('\n')
      throw new Error(`Expired quarantine entries; renew or remove them:\n${detail}`)
    }),
).pipe(Command.withDescription('Fail when a quarantine ledger holds expired or malformed entries'))

const quarantineAnnounceCommand = Command.make(
  'announce',
  {
    ledger: nonEmptyTextOption({
      name: 'ledger',
      description: 'Path to the quarantine ledger JSON',
    }),
    key: nonEmptyTextOption({
      name: 'key',
      description: 'Quarantine key naming the ledger entry that tolerates this failure',
    }),
    label: nonEmptyTextOption({
      name: 'label',
      description: 'Test target whose failure was tolerated; must match the entry target',
    }),
    summaryFile: Options.string('summary-file').pipe(
      Options.withDescription('Job summary file to append to (defaults to $GITHUB_STEP_SUMMARY)'),
      Options.withDefault(''),
    ),
  },
  ({ ledger, key, label, summaryFile }) =>
    Effect.sync(() => {
      const entry = resolveQuarantineEntry({ ledger: readLedger(ledger), key, label })
      const summary = renderQuarantineAnnouncement({ label, entry })

      const summaryPath =
        optionalString(summaryFile) ?? optionalString(process.env.GITHUB_STEP_SUMMARY ?? '')
      if (summaryPath !== undefined) {
        appendFileSync(summaryPath, renderQuarantineSummaryLine(summary))
      }

      // stdout is GitHub's documented channel for workflow commands, and a devenv task's
      // stdout does reach the runner (measured; see the quarantine spec).
      process.stdout.write(`${renderQuarantineAnnotation(summary)}
`)
    }),
).pipe(
  Command.withDescription(
    'Announce a tolerated test failure to the job summary and as an annotation',
  ),
)

/** CLI command for declaring and checking tolerated test failures. */
export const quarantineCommand = Command.make('quarantine').pipe(
  Command.withSubcommands([quarantineValidateCommand, quarantineAnnounceCommand]),
  Command.withDescription('Quarantine ledger validation and tolerated-failure announcements'),
)

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
  Command.withSubcommands([workflowReportCommand, deployCommand, quarantineCommand]),
  Command.withDescription('CI automation helpers'),
)
