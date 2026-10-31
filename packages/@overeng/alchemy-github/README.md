# Alchemy GitHub App

`@overeng/alchemy-github` adds `GitHub.App` to Alchemy v2 and re-exports the existing resources from `@alchemy.run/github`, including **Ruleset**. Its `providers()` composes the App provider with upstream GitHub authentication, credentials and resource providers. There is no second Ruleset implementation or authentication provider.

## Supported versions

This package targets **Alchemy `2.0.0-beta.84`** and **`@alchemy.run/github` `2.0.0-beta.84`**, with Effect **4.1.0**. Alchemy and Effect are peer dependencies, with pinned development versions supplied by the workspace catalog, so applications share their existing runtime rather than receiving a second copy.

The npm `next` tag was inspected first: it pointed to `2.0.0-beta.72`, whose bundled GitHub provider imports the old `effect/unstable/*` layout and cannot run against stable Effect 4. The approved `latest` beta.84 uses the stable layout and extracts GitHub into `@alchemy.run/github`. Its `effect: ^4.0.5` peer accepts 4.1.0. The workspace's Effect cohort must be upgraded before installing this package.

## Private-key security boundary

**The App private key is never an Alchemy input, output or persisted attribute, even as `Redacted`.** Alchemy's `Redacted` state encoding preserves the underlying value; log redaction is not state encryption. Instead, conversion seals the PEM directly into a declared GitHub Actions repository or environment secret in the same process. Outputs contain only non-secret registration facts, observed secret destination/timestamps and a SHA-256 public-key fingerprint. No PEM is written to a temporary file or attached to an error.

Use a protected state backend and never commit `.alchemy/` state. Built-in resources retain their upstream secret/state semantics. JavaScript cannot guarantee physical erasure of immutable strings from memory; the conversion key is kept local and never retained as resource state. The mutable byte buffer used for encryption is zeroed after sealing.

The conversion POST, its public-key preflight GET and its sealed-secret PUT use direct HTTP requests with manual redirect handling, no retries and no request logger. They deliberately bypass Octokit's request-log plugin, which can print expanded callback URLs before provider error sanitization. Error responses are discarded without logging their bodies. Other package-owned Octokit calls carry only App/secret metadata, public keys, sealed ciphertext or explicitly non-secret variable values; they never receive the callback code or PEM.

The deployment credentials configured through upstream `GitHub.providers()` need Actions secret access to the selected repository/environment. They are separate from the generated App's runtime credential. The new App can request only `checks: write` and be installed only on the intended repository.

## Repository-scoped remote state

`githubRepoState()` stores Alchemy state in an S3-compatible R2 bucket using temporary credentials from an explicitly configured broker. `githubActionsOidc({ brokerUrl })` is the default Actions credential layer; there is no built-in broker URL. It reads `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` through Effect Config, requests an OIDC token with the broker URL as its audience, and POSTs `{ token }` to that broker. The broker must validate the Actions identity and authorize the repository before returning credentials scoped to `alchemy/v1/owner/repo/`.

```ts
import * as Alchemy from 'alchemy'
import * as GitHub from '@overeng/alchemy-github'
import { Layer } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

const state = GitHub.githubRepoState().pipe(
  Layer.provide(
    GitHub.githubActionsOidc({
      brokerUrl: 'https://state-broker.example.com/credentials',
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
)

export default Alchemy.Stack(
  'RepositoryChecks',
  { providers: GitHub.providers(), state },
  GitHub.App('check-publisher', {
    owner: 'example-org',
    ownerType: 'organization',
    manifest: {
      name: 'Example Check Publisher',
      url: 'https://example.com/checks',
      redirectUrl: 'https://example.com/github-app-callback',
      permissions: { checks: 'write' },
    },
    privateKeySecret: {
      owner: 'example-org',
      repository: 'example-project',
      environment: 'production',
      name: 'CHECK_PUBLISHER_PRIVATE_KEY',
    },
  }),
)
```

The broker response contains `accessKeyId`, `secretAccessKey`, `sessionToken`, `endpoint`, `bucket`, `prefix`, and an ISO `expiresAt`. Credentials are cached in memory, concurrent refreshes share one exchange, and the next read refreshes them one minute before expiry. Failures discard upstream requests, response bodies and causes; credential HTTP tracing and trace-header propagation are disabled. Use a normal HTTP client without request/body logging or redirect middleware. The Actions bearer token, OIDC JWT and R2 credentials are never written to state.

Credential and signed storage requests force Fetch's `redirect: 'manual'`; every 3xx response fails rather than forwarding credentials. Broker prefixes accept only `alchemy/v1/<owner>/<repo>/` with ASCII letters, digits, `_`, `-`, and `.` within each name, excluding the standalone `.` and `..` names and all percent-encoding. Object keys that URL normalization would alter are rejected before transmission; literal percent signs are escaped so encoded-looking names cannot traverse directories.

State is **sensitive metadata**, not a secret store. This backend does not add state encryption. In the supported Alchemy beta.84, state encoding unwraps `Redacted` values into plaintext state markers; redaction protects inspection/logging, not persisted values. Our GitHub App attributes exclude the App private key, but arbitrary resources can persist sensitive inputs, attributes and outputs, including `Redacted` secrets. Do not put plaintext secrets into resource state; apply private bucket access, repository-scoped temporary credentials, retention policies and appropriate encryption controls to the stored objects.

An Actions job must grant OIDC permission and select the protected environment expected by the broker's authorization policy:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx alchemy deploy
```

Actions injects the OIDC request environment variables automatically for a job with `id-token: write`; do not create long-lived R2 secrets in the workflow. Deployment authentication for GitHub resources is configured separately through the upstream providers. Protect the `production` environment and configure broker policy to require that environment and the intended repository/workflow identity.

## Two-step App registration

Declare the App in an Alchemy stack:

```ts
import * as Alchemy from 'alchemy'
import { localState } from 'alchemy/State/LocalState'
import * as GitHub from '@overeng/alchemy-github'
import { Effect } from 'effect'

export default Alchemy.Stack(
  'RepositoryChecks',
  {
    providers: GitHub.providers(),
    // Protect the local filesystem; use a protected remote store for teams.
    state: localState(),
  },
  Effect.gen(function* () {
    const app = yield* GitHub.App('check-publisher', {
      owner: 'example-org',
      ownerType: 'organization',
      manifest: {
        name: 'Example Check Publisher',
        url: 'https://example.com/checks',
        redirectUrl: 'https://example.com/github-app-callback',
        permissions: { checks: 'write' },
        events: [],
      },
      privateKeySecret: {
        owner: 'example-org',
        repository: 'example-project',
        environment: 'production', // Omit for a repository Actions secret.
        name: 'CHECK_PUBLISHER_PRIVATE_KEY',
      },
      ...(process.env.GITHUB_APP_MANIFEST_CODE_STATE === undefined
        ? {}
        : { conversion: { state: process.env.GITHUB_APP_MANIFEST_CODE_STATE } }),
    })
    return { app }
  }),
)
```

1. Deploy **without** `conversion`. The resource persists `status: 'pending'`, a portable `manifestHtml` form, `formUrl`, callback `state`, `startedAt` and `expiresAt`. Serve the form from a trusted page or save the non-secret form locally. The URL alone does not contain the POSTed manifest.
2. The owner submits the form and confirms the App on GitHub. GitHub redirects to `redirectUrl` with a one-time `code` and `state`. Verify state matches the pending registration. Complete within the one-hour window. The provider never opens or automates a browser.
3. Set `GITHUB_APP_MANIFEST_CODE` to the one-use code and `GITHUB_APP_MANIFEST_CODE_STATE` to its callback state, then deploy the same resource again. Only the state token enters resource props. The default `ManifestCodes.fromEnv('GITHUB_APP_MANIFEST_CODE')` reads the code and companion `_STATE` variable during apply, verifies the token, then converts once and writes the sealed PEM directly to the secret. Neither planning nor provider construction reads the code. Remove both variables after success. Webhooks are disabled unless explicitly configured.
4. Install the App through GitHub's UI. Supply `installationId` explicitly if it is needed by the stack. It is an operator assertion, not inferred from `appId` or verified with a key the provider no longer holds.

Registered outputs include `appId`, `integrationId` (equal to `appId`), `slug`, `clientId` where returned, optional `installationId`, the public-key fingerprint, observed permissions/events, and `privateKeySecret` metadata including repository/environment scope and `updatedAt`. A pending App cannot yet supply a required-check integration ID: declare dependent resources after registration instead of treating pending as success.

**Breaking API change:** `conversion.code` is no longer accepted. Alchemy persists resource props before reconciliation and unwraps Redacted values when encoding state; wrapping a code in Redacted does not protect durable state. Keep callback codes exclusively in `ManifestCodeSource`, never in resource props or stack outputs. Existing state written by older versions may contain an unspent code: protect that state, let the code expire, and remove it from retained state copies according to your state-store policy.

For a different environment variable prefix, pass `manifestCodeSource: GitHub.ManifestCodes.fromEnv('CUSTOM_CODE')` to `GitHub.providers()`, then set `CUSTOM_CODE` and `CUSTOM_CODE_STATE`. For an interactive workflow, inject `GitHub.ManifestCodes.fromPrompt(prompt)`; the Effect callback receives the pending state and must securely prompt for and return `{ state, code: Redacted.make(code) }`. The source validates that the entered callback state matches that pending token. Do not log callback values. Prompts run only during apply, after the replay baseline and encryption preflight.

### Recovery and drift

There is no transaction spanning one-use conversion, the Actions PUT and Alchemy's state write. Preflight and interruption masking reduce the vulnerable window but cannot eliminate crashes or ambiguous network responses. **Do not blindly retry conversion.** Inspect GitHub's owner UI; if conversion occurred, revoke/rotate the key there, seed the declared Actions secret through a trusted secret-management path, and adopt by slug. A pre-existing secret or failed PUT cannot prove the correct key was saved. Recovery errors exclude the PEM, callback code and upstream response body.

If conversion succeeds and the owner edited its grants, the typed drift error identifies the created slug and confirms the key was sunk. Fix the App settings, remove `conversion`, set `adopt: { slug: 'the-created-slug' }`, and deploy using the same secret destination. The pending Alchemy attributes are recovered by explicit adoption. Form issuance records the secret's GitHub `updated_at`, or absence, as a non-secret baseline. Conversion refuses if the current GitHub observation differs; no comparison with the local clock is involved. A prior conversion or an unrelated writer may have changed the secret: inspect the owner UI, adopt by slug if an App was created, or otherwise remove `conversion` and reissue the form after its pending window expires. Older pending state without a baseline fails closed. This guard cannot prove key identity, prevent concurrent writes after the check, or distinguish writes within GitHub timestamp precision. As a second defence, conversion POST retries are disabled and GitHub's documented 404/422 rejections map to a sanitized typed recovery error. GitHub documents those statuses but does not specify which is returned for every consumed-code case; no live replay was performed.

Permission/event drift is a typed hard error with a diff and UI remedy, never an automatic permission update. Correct the GitHub App settings and approve installation permission changes before redeploying. Both the read hook and normal registered planning fetch live public metadata and secret metadata; planning never trusts persisted grants alone. Observation uses `GET /apps/{slug}` because the sink-only model deliberately cannot authenticate `GET /app` with a private key. Secret existence/timestamps cannot prove its value belongs to this App; timestamp drift drops a now-unverifiable fingerprint.

### Adoption and deletion

Use `adopt: { slug: 'example-check-publisher' }` with the existing `privateKeySecret` destination. The secret must exist. Optional `appId` and `clientId` assertions are checked against metadata where returned. Optional `installationId` is explicitly unverifiable. ID-only adoption is not supported. Adoption never obtains a key or invents a fingerprint.

GitHub supports `DELETE /app/installations/{id}` with an App JWT, but has **no REST API to delete an App registration**. A sink-only provider has no key for uninstall. Registered destroy therefore fails closed. Delete/uninstall in the owner UI, or set `destroy: 'orphan'` to relinquish Alchemy ownership while leaving the App and secret untouched. Pending state can be removed without that flag. Key rotation is an explicit manual operation outside this resource and must preserve the same sink-only boundary.

## Actions secrets

`GitHub.ActionsSecret` accepts a reasoned, concrete 1Password reference, never a raw secret value:

```ts
const signingSecret =
  yield *
  GitHub.ActionsSecret('SigningSecret', {
    owner: 'example',
    repository: 'target',
    environment: 'production', // omit for repository scope
    name: 'SIGNING_TOKEN',
    value: {
      ref: 'op://aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb/token',
      reason: 'Publish the declared deployment signing token to Actions',
    },
    hashKey: {
      ref: 'op://aaaaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccc/hmac',
      reason: 'Detect changes using this stack-specific HMAC key',
    },
  })
```

Provision the referenced items and a separate HMAC key per stack externally. Apply resolves values through `SecretSource`, encrypts with the scope's Actions public key using the same sealed-box helper as App conversion, includes `key_id`, and zeroes mutable value/key buffers after PUT or failure. State contains only secret metadata and, with `hashKey`, HMAC-SHA256 plus the key reference; neither the value nor the HMAC key enters outputs, state or diagnostic causes. There is no value cache. Node/Bun immutable strings used by the CLI JSON decoder are transient and garbage-collected, not securely erasable.

Default plans observe the live GitHub secret metadata and, when `hashKey` is configured, read both handles and compare the HMAC with state. Without `hashKey`, only existence and `updated_at` detect drift. Set `driftMode: 'updatedAtOnly'` to prevent all value/key reads during planning, even with a hash key configured. GitHub timestamps do not prove secret contents or distinguish same-timestamp writes. Apply still reads the source to perform an authorized update. Destroy deletes a managed secret unless `retain: true`. Names, scope and host are immutable.

Secret names are normalized to uppercase for GitHub requests, identity and persisted metadata; changing only their case does not move the resource.

The default `SecretSourceLive` uses the runtime `ChildProcessSpawner` and runs only `op-proxy read <ref> --reason <reason> --cache none --fresh --output json`; it discards stderr and sanitizes failures. No raw `op`, temp secret files, or mutations are used. `GitHub.providers({ ...options, secretSource: customSourceLayer })` can inject another `SecretSource` implementation. **Current op-proxy CLI limitation:** it trims original boundary whitespace before JSON encoding; the adapter performs no additional trimming. Use a byte-preserving injected source for whitespace-significant values until the CLI supplies a lossless read contract.

### Narrowest GitHub App repository permissions

| Resource/scope             | Plan/read                                                | Apply/destroy       |
| -------------------------- | -------------------------------------------------------- | ------------------- |
| ActionsSecret, repository  | Secrets: read (metadata and public key)                  | Secrets: write      |
| ActionsSecret, environment | Environments: read (metadata and environment public key) | Environments: write |

Write permission includes the corresponding read operations. Restrict the App installation to the target repository; this resource does not need Actions workflow read/write, Contents, organization Secrets, or an App private key in state. The environment must already exist. Permission names and endpoint scopes follow GitHub's [Actions secrets REST documentation](https://docs.github.com/en/rest/actions/secrets). The same permission table applies to the App conversion sink.

## Actions variables

`GitHub.ActionsVariable` manages a plain, non-secret repository or environment variable. Its value is intentionally stored in Alchemy state and outputs; use `ActionsSecret` for confidential values.

```ts
const releaseChannel =
  yield *
  GitHub.ActionsVariable('release-channel', {
    owner: 'example-org',
    repository: 'example-project',
    environment: 'production', // omit for repository scope
    name: 'RELEASE_CHANNEL',
    value: 'stable',
  })
```

Plans read the current value from GitHub, so remote edits and deletion are repaired even when the declaration has not changed. Apply creates or updates the variable. Destroy deletes it unless `retain: true` is declared. Owner, repository, environment, name and API host are immutable resource identity; use a new resource identity to move a variable.

Variable names are normalized to uppercase in requests, comparisons and state, matching GitHub. Case-only declaration changes preserve identity.

| Resource/scope               | Plan/read          | Apply/destroy       |
| ---------------------------- | ------------------ | ------------------- |
| ActionsVariable, repository  | Variables: read    | Variables: write    |
| ActionsVariable, environment | Environments: read | Environments: write |

These are repository permissions; write includes read, and the environment must already exist. See GitHub's [Actions variables REST documentation](https://docs.github.com/en/rest/actions/variables). The separate resource adds live plan-time drift observation; upstream's `Variable` remains available unchanged.

## Repository labels

`GitHub.Labels` manages definitions, not issue/pull-request label assignments. Load the repository's file with the exported `LabelsFileSchema` / `LabelDefinitionSchema` contract:

```ts
const labels = yield * GitHub.loadLabelsFile('.github/labels.json')
const applied =
  yield *
  GitHub.Labels('repository-labels', {
    owner: 'example-org',
    repo: 'example-project',
    labels,
    // deleteUnmanaged: true, // destructive opt-in; false by default
  })
```

The JSON envelope is `{ "labels": [{ "name": "bug", "color": "d73a4a", "description": "A defect" }] }`; other envelope metadata is ignored. Colors are exactly six hexadecimal digits without `#`. Names must be unique ignoring case. An omitted description means an empty description, so existing descriptions are cleared.

Plans and read observations list all pages of repository labels. Missing managed labels or color/description drift trigger an update; case-only name differences do not rename labels. Unmanaged names and managed drift are reported through Effect logs, never added to the ownership receipt. `deleteUnmanaged: true` deletes every label outside the declared set, including labels created by other tools; otherwise they are left alone. Renames are not supported: changing a name declares a different label and leaves the previous one unmanaged unless deletion is explicitly enabled.

Outputs/state attributes contain only `managed` names and their last-applied values. Read observations preserve that receipt rather than replacing it with external edits. Destroy lists live labels and deletes only managed labels whose name (ignoring case), color and description still match the receipt; missing, externally edited and unmanaged labels are left alone. A concurrent writer between observation and deletion cannot be protected by the labels API, which has no conditional delete contract here. Do not manage the same label set from multiple resources.

The App installation needs **Issues: write OR Pull requests: write** repository permission for create/update/delete; either permission suffices. Listing needs the corresponding read permission (or public repository access). GitHub documents both alternatives for [create](https://docs.github.com/en/rest/issues/labels#create-a-label), [update](https://docs.github.com/en/rest/issues/labels#update-a-label), [delete](https://docs.github.com/en/rest/issues/labels#delete-a-label), and [list](https://docs.github.com/en/rest/issues/labels#list-labels-for-a-repository). No new secret handling is involved.

## Required checks with the upstream Ruleset

The beta.84 provider already supports the consumer's required-check integration ID, strict policy, bypass actors and observed-policy comparison on updates. Use its camelCase contract directly:

```ts
const ruleset =
  yield *
  GitHub.Ruleset('required-check', {
    owner: 'example-org',
    repository: 'example-project',
    name: 'Required publisher check',
    enforcement: 'active',
    conditions: { include: ['~DEFAULT_BRANCH'], exclude: [] },
    rules: {
      requiredStatusChecks: {
        checks: [{ context: 'publisher', integrationId: appId }],
        strictRequiredStatusChecksPolicy: true,
      },
    },
    bypassActors: [{ actorId: appId, actorType: 'Integration', bypassMode: 'pull_request' }],
  })
```

`appId` is the registration ID, not an installation ID. Upstream maps these fields to `required_status_checks[].integration_id`, `strict_required_status_checks_policy`, and `bypass_actors`. On reconciliation it reads actual policy, compares controlled fields, and PUTs only when they differ. This is not an additional no-op plan drift detector. Upstream supports name-based adoption through `adopt(true)` and defaults removal to retain; opt into Alchemy's destroy removal policy deliberately when deletion is wanted. The package does not promise ID-based adoption or the full genie ruleset schema.

## Tests and live lanes

Unit tests cover manifest generation/default-disabled hooks, escaping and drift diffs. Local HTTP integration tests implement conversion, App observation and repository/environment Actions secret endpoints, decrypt the sealed payload, and assert PEM absence from serialized Alchemy state, outputs, logs and errors. A contract test asserts Ruleset is exactly upstream's resource, not a competing provider.

Real beta.84 Plan/Deploy engine tests persist registration attributes, then verify unchanged redeploys reject live permission/event drift and missing secrets. Host tests cover GitHub.com, data-residency browser/API origins, and Enterprise Server. Conversion recovery tests retain pending attributes after a post-sink drift error, reject replay, and recover via explicit adoption.

### Blocking sandbox resource lane

The `alchemy-github/live` CI check runs only on pushes to `main` and `merge_group`, never on pull requests. It uses environment `alchemy-github-live` and fails if required configuration is missing; missing credentials are not a successful skip. Provision the sandbox App and environment before enabling/merging the workflow.

Configure these environment values without checking their contents into source:

- Secret `ALCHEMY_GITHUB_SANDBOX_REPO`: sandbox `owner/repo`; secret-backed so GitHub masks the full identity in logs. Preflight also masks owner and repository components separately.
- Variable `ALCHEMY_GITHUB_SANDBOX_APP_ID`: the dedicated App's ID.
- Secret `ALCHEMY_GITHUB_SANDBOX_APP_PRIVATE_KEY`: its PEM.

Install the App only on the intended sandbox repository. The job mints a repository-restricted installation token, generates and masks a random secret fixture, and passes `ALCHEMY_GITHUB_SANDBOX_LIVE=1`, `ALCHEMY_GITHUB_SANDBOX_TOKEN`, `ALCHEMY_GITHUB_SANDBOX_RUN_ID`, and `ALCHEMY_GITHUB_SANDBOX_SECRET_VALUE` to the unbounded tests. No op-proxy source is used. The App needs repository **Variables: write**, **Secrets: write**, and either **Issues: write** or **Pull requests: write** (label definitions); corresponding read operations are included. No sandbox repository name is embedded in the workflow or tests.

The lane exercises Actions variable create/update/delete, an env-backed Actions secret sink, and Labels create/update/destroy with unique run-prefixed names. Each case cleans up its own resources, never unmanaged labels. Alchemy state is local to the job and is not uploaded. The sandbox lane does not create Apps or use manifest conversion; the App exists before the lane runs.

The job and local sandbox harness set `ALCHEMY_TELEMETRY_DISABLED=1` and assert Alchemy's resolved opt-out before running resources. Consumers passing secret-backed identities or props should also disable Alchemy telemetry: log masking does not protect data sent to external telemetry exporters.

Ruleset mutation is intentionally excluded: it would require the broader **Administration: write** permission, which these resource checks do not otherwise need. Cleanup finalizers run on ordinary test failures; a hard runner/process termination can still leave run-prefixed fixtures for an operator to inspect and remove.

### Manual read-only App adoption

The manual **read-only App adoption** lane is skipped unless all these variables are set:

- `ALCHEMY_GITHUB_LIVE=1`
- `ALCHEMY_GITHUB_LIVE_TOKEN`: deployment token with access to existing secret metadata
- `ALCHEMY_GITHUB_LIVE_REPOSITORY`: explicit sandbox `owner/repository`
- `ALCHEMY_GITHUB_LIVE_APP_SLUG`: an existing App
- `ALCHEMY_GITHUB_LIVE_SECRET_NAME`: its existing Actions secret
- Optionally `ALCHEMY_GITHUB_LIVE_SECRET_ENVIRONMENT`

Run `devenv tasks run test:alchemy-github` for bounded local tests, or `devenv tasks run test:alchemy-github:unbounded` for the credentialed/manual complement after installing the supported cohort. Buck excludes `src/App.live.test.ts` and `src/Sandbox.live.test.ts` from bounded collection. The separate App-adoption suite makes GET requests only; the explicitly enabled sandbox suite performs run-scoped mutations. Normal bounded tests need no credentials. Live coverage must be exercised separately; local HTTP tests do not prove real GitHub behavior.

API references: [manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [Apps REST](https://docs.github.com/en/rest/apps/apps), [repository rulesets](https://docs.github.com/en/rest/repos/rules), [Actions secrets](https://docs.github.com/en/rest/actions/secrets).
