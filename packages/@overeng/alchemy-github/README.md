# Alchemy GitHub App

`@overeng/alchemy-github` adds `GitHub.App` to Alchemy v2 and re-exports the existing resources from `@alchemy.run/github`, including **Ruleset**. Its `providers()` composes the App provider with upstream GitHub authentication, credentials and resource providers. There is no second Ruleset implementation or authentication provider.

## Supported versions

This package targets **Alchemy `2.0.0-beta.84`** and **`@alchemy.run/github` `2.0.0-beta.84`**, with Effect **4.1.0**. Alchemy and Effect are peer dependencies, with pinned development versions supplied by the workspace catalog, so applications share their existing runtime rather than receiving a second copy.

The npm `next` tag was inspected first: it pointed to `2.0.0-beta.72`, whose bundled GitHub provider imports the old `effect/unstable/*` layout and cannot run against stable Effect 4. The approved `latest` beta.84 uses the stable layout and extracts GitHub into `@alchemy.run/github`. Its `effect: ^4.0.5` peer accepts 4.1.0. The workspace's Effect cohort must be upgraded before installing this package.

## Private-key security boundary

**The App private key is never an Alchemy input, output or persisted attribute, even as `Redacted`.** Alchemy's `Redacted` state encoding preserves the underlying value; log redaction is not state encryption. Instead, conversion seals the PEM directly into a declared GitHub Actions repository or environment secret in the same process. Outputs contain only non-secret registration facts, observed secret destination/timestamps and a SHA-256 public-key fingerprint. No PEM is written to a temporary file or attached to an error.

Use a protected state backend and never commit `.alchemy/` state. Built-in resources retain their upstream secret/state semantics. JavaScript cannot guarantee physical erasure of immutable strings from memory; the conversion key is kept local and never retained as resource state. The mutable byte buffer used for encryption is zeroed after sealing.

The deployment credentials configured through upstream `GitHub.providers()` need Actions secret access to the selected repository/environment. They are separate from the generated App's runtime credential. The new App can request only `checks: write` and be installed only on the intended repository.

## Two-step App registration

Declare the App in an Alchemy stack:

```ts
import * as Alchemy from 'alchemy'
import { localState } from 'alchemy/State/LocalState'
import * as GitHub from '@overeng/alchemy-github'
import { Effect, Redacted } from 'effect'

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
      ...(process.env.APP_MANIFEST_CODE === undefined ? {} : {
        conversion: {
          code: Redacted.make(process.env.APP_MANIFEST_CODE),
          state: process.env.APP_MANIFEST_STATE!,
        },
      }),
    })
    return { app }
  }),
)
```

1. Deploy **without** `conversion`. The resource persists `status: 'pending'`, a portable `manifestHtml` form, `formUrl`, callback `state`, `startedAt` and `expiresAt`. Serve the form from a trusted page or save the non-secret form locally. The URL alone does not contain the POSTed manifest.
2. The owner submits the form and confirms the App on GitHub. GitHub redirects to `redirectUrl` with a one-time `code` and `state`. Verify state matches the pending registration. Complete within the one-hour window. The provider never opens or automates a browser.
3. Set `APP_MANIFEST_CODE` and `APP_MANIFEST_STATE` and deploy the same resource again. The provider checks state/expiration, preflights the Actions public key, converts the code once, and writes the sealed PEM directly to the secret. Remove the conversion environment variables after success. Webhooks are disabled unless explicitly configured.
4. Install the App through GitHub's UI. Supply `installationId` explicitly if it is needed by the stack. It is an operator assertion, not inferred from `appId` or verified with a key the provider no longer holds.

Registered outputs include `appId`, `integrationId` (equal to `appId`), `slug`, `clientId` where returned, optional `installationId`, the public-key fingerprint, observed permissions/events, and `privateKeySecret` metadata including repository/environment scope and `updatedAt`. A pending App cannot yet supply a required-check integration ID: declare dependent resources after registration instead of treating pending as success.

### Recovery and drift

There is no transaction spanning one-use conversion, the Actions PUT and Alchemy's state write. Preflight and interruption masking reduce the vulnerable window but cannot eliminate crashes or ambiguous network responses. **Do not blindly retry conversion.** Inspect GitHub's owner UI; if conversion occurred, revoke/rotate the key there, seed the declared Actions secret through a trusted secret-management path, and adopt by slug. A pre-existing secret or failed PUT cannot prove the correct key was saved. Recovery errors exclude the PEM, callback code and upstream response body.

Permission/event drift is a typed hard error with a diff and UI remedy, never an automatic permission update. Correct the GitHub App settings and approve installation permission changes before redeploying. The read hook observes public metadata and planning compares it against the current declaration. Observation uses `GET /apps/{slug}` because the sink-only model deliberately cannot authenticate `GET /app` with a private key. Secret existence/timestamps cannot prove its value belongs to this App; timestamp drift drops a now-unverifiable fingerprint.

### Adoption and deletion

Use `adopt: { slug: 'example-check-publisher' }` with the existing `privateKeySecret` destination. The secret must exist. Optional `appId` and `clientId` assertions are checked against metadata where returned. Optional `installationId` is explicitly unverifiable. ID-only adoption is not supported. Adoption never obtains a key or invents a fingerprint.

GitHub supports `DELETE /app/installations/{id}` with an App JWT, but has **no REST API to delete an App registration**. A sink-only provider has no key for uninstall. Registered destroy therefore fails closed. Delete/uninstall in the owner UI, or set `destroy: 'orphan'` to relinquish Alchemy ownership while leaving the App and secret untouched. Pending state can be removed without that flag. Key rotation is an explicit manual operation outside this resource and must preserve the same sink-only boundary.

## Required checks with the upstream Ruleset

The beta.84 provider already supports the consumer's required-check integration ID, strict policy, bypass actors and observed-policy comparison on updates. Use its camelCase contract directly:

```ts
const ruleset = yield* GitHub.Ruleset('required-check', {
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

## Tests and manual live lane

Unit tests cover manifest generation/default-disabled hooks, escaping and drift diffs. Local HTTP integration tests implement conversion, App observation and repository/environment Actions secret endpoints, decrypt the sealed payload, and assert PEM absence from serialized Alchemy state, outputs, logs and errors. A contract test asserts Ruleset is exactly upstream's resource, not a competing provider.

The manual **read-only App adoption** lane is skipped unless all these variables are set:

- `ALCHEMY_GITHUB_LIVE=1`
- `ALCHEMY_GITHUB_LIVE_TOKEN`: deployment token with access to existing secret metadata
- `ALCHEMY_GITHUB_LIVE_REPOSITORY`: explicit sandbox `owner/repository`
- `ALCHEMY_GITHUB_LIVE_APP_SLUG`: an existing App
- `ALCHEMY_GITHUB_LIVE_SECRET_NAME`: its existing Actions secret
- Optionally `ALCHEMY_GITHUB_LIVE_SECRET_ENVIRONMENT`

Run `devenv tasks run test:alchemy-github` after installing the supported cohort. The live lane makes GET requests only; no App creation, conversion, installation or secret mutation is automated. Normal tests need no credentials, and no live lane has been exercised as part of this change.

API references: [manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [Apps REST](https://docs.github.com/en/rest/apps/apps), [repository rulesets](https://docs.github.com/en/rest/repos/rules), [Actions secrets](https://docs.github.com/en/rest/actions/secrets).
