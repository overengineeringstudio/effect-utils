# Architecture A: in-process Effect GitHub App auth

This document contains the original architecture bakeoff and its historical evidence. The consolidation hardening below supersedes its global semaphore and token-only gh-ci-utils integration; no Ulrike deployment or code is changed by this branch.

This is a tested architecture candidate, not an activated GitHub App or a control-service rollout.

## Composition

```text
GitHub App settings <-- reviewed App manifest / reconciliation
                              |
1Password <-- secretspec inventory --> op-proxy --> host-local 0600 PEM
                                                   |
                                        Effect FileSystem + Redacted
                                                   |
                  +--------------------------------+------------------+
                  | dedicated service process (one App key per process) |
                  | @overeng/utils/node/github-app                      |
                  | Schema config -> parsed RSA key -> RS256 JWT        |
                  | scoped token cache / refresh / single-flight        |
                  | GitHubAppHttpClient Effect layer                    |
                  +----------------------+------------------------------+
                                         |
                           GitHub installation-token endpoint
                           repositories + permissions in mint body
                                         |
                          repository REST APIs (issues/comments/CI)
```

The prototype uses an existing package subpath, `@overeng/utils/node/github-app`, rather than making consumers depend on gh-ci-utils and its CLI/UI graph. gh-ci-utils already depends on utils; no new upstream package catalog, peer-version cohort, or workspace member is needed. The subpath imports only Effect and Node crypto. Installation of the utils package still brings its broad dependency graph: this is a real downside compared with a dedicated `@overeng/github-app` package. If this candidate wins, a standalone package is reasonable when independent publication/versioning or minimal install closure outweighs the extra repository plumbing. There is one implementation, not an alias retained at the old GitHubClient JWT path.

`AppIdentity` validates the authentication client ID. `AppConfig` requires a `Redacted<string>` PEM. `InstallationScope` requires a positive installation ID, non-empty repository names, and non-empty permissions. Neither repository nor permission omission can accidentally request full installation authority. GitHub checks permission names and the upper bound granted by the installation; the library does not invent a second GitHub permission registry.

`makeGitHubApp` acquires the raw Effect HttpClient and parses the RSA key once. Its `token(scope)` returns a Redacted token. Cache keys include installation, sorted/deduplicated repositories, and sorted permissions, so different authorities never share a cache entry. One semaphore deduplicates concurrent first callers and serializes refreshes. JWTs use `iat = now - 60s`, `exp = now + 540s`, and the configured client ID as `iss`; maximum claim interval is 600s. Tokens refresh when 60s or less remain. Responses and key/config inputs are schema-decoded; auth failures are tagged and do not retain secret response bodies or PEM exceptions.

`GitHubApp.layer(config)` composes with the ordinary transport. `installationHttpClientLayer(scope)` exposes a distinct `GitHubAppHttpClient` service so the raw transport never accidentally authenticates its own mint request. The typed HttpClient rejects another origin before minting, injects GitHub headers and a scoped token, and invalidates a rejected token on 401. It never replays writes. Comparison against the rejected token prevents a late 401 from clearing a replacement token. The caller decides whether another operation is safe. Do not log raw HttpClient requests/headers: platform transport and response-decoding errors can carry request metadata.

## Single sources of truth

| Item | Authority | Projection/runtime ownership |
| --- | --- | --- |
| App identity | Reviewed per-App manifest/settings; client ID is auth identity, numeric App ID remains inventory/UI identity | Nix-rendered service config; Schema checks at runtime |
| Maximum App permissions / selected installation repos | App manifest/settings and GitHub installation acceptance | Actual GitHub grant is the enforcement ceiling; request down-scoping cannot enlarge it |
| Installation IDs | Existing declarative bot inventory or manifest; new Ulrike entry only after real App installation | Host config passes the ID; library never discovers or guesses installations |
| Private key | 1Password; secretspec records the inventory binding, not the value | op-proxy provisions per-service owned 0600 PEM; process holds parsed key and Redacted input |
| Installation token | GitHub token exchange | Process-local memory only; never Nix, disk, 1Password, or RPC output |
| Consumer policy | Reviewed service config/composition, e.g. Ulrike: dotfiles + issues:write | Mandatory down-scope on each requested token; library is mechanism, not a centralized policy authority |

The existing Nix/op-proxy/secretspec pattern stays declarative. App/key provisioning is not hidden inside the library, and runtime code does not contain installation IDs or secret locators. Add the real Ulrike client ID, installation ID, and 1Password inventory binding to the owning declarations once Johannes creates/installs the App; no identifiers were invented in this prototype. `CREDENTIALS.md` is the inventory index, not a fourth key store. The prototype performs no secret reads and no real GitHub API mutations.

## Lifecycles

- **Key rotation:** issue a new App key, replace the 1Password item field, materialize the PEM atomically with existing op-proxy machinery, then restart each consumer. Each process parses once; file replacement alone does not refresh its key. Confirm the new consumer's mint before deleting the old App key. Deleting a key is not a substitute for revoking already issued installation tokens.
- **App permission change:** change the reviewed App manifest/settings, have installation owners accept newly requested permissions, then change the consumer scope and restart. Tighten scope first when reducing authority. A missing grant fails token exchange; do not broaden scope or fall back to a PAT automatically.
- **New consumer:** identify its repository/permission need and trust boundary, select a dedicated App or justify sharing, declare identity/install/key binding in existing Nix/secretspec sources, provision a per-service key file, and compose the same library/layer. No new signing code or daemon/protocol is needed.
- **Expiry/revocation:** refresh lazily before expiry with single-flight. Authenticated HttpClient 401 invalidates and returns an error without replay. Next explicit operation mints again. Mint 401/403/404 is a typed failure, not an infinite retry. Network errors cannot cause a write replay. Token-only integrations own their HTTP 401 behavior; gh-ci-utils deliberately retains its existing request/error semantics while using the shared minter.
- **Host move:** move declarative service and secret-access entitlement; provision the PEM on the destination; stop/revoke/remove the source service/key file; start fresh with an empty token cache. There is no broker address or token state to migrate. Each extra key recipient expands the compromise boundary.
- **App deletion:** stop consumers/remove inventory bindings and provisioned key files, then delete the App/installations and key records according to the retention policy. Requests fail closed; Ulrike has no CLI/PAT fallback. Existing gh-ci-utils retains its explicit interactive CLI fallback for owners without an installation.

## Migration and upstreaming

1. Merge the extracted utils subpath and its fake-server tests. gh-ci-utils loses its local signer, PEM cache, and installation-token cache/exchange and instead uses `makeGitHubApp`. Its token requests select only the requested repository with actions:write/checks:read/contents:read/pull_requests:read; existing interactive CLI fallback, budgets, ETags, GraphQL, and log-storage redirect policy stay in gh-ci-utils. Installation grants must cover that declared policy before migrating a deployment.
2. Adopt the same subpath in the dotfiles vendored exporter; delete its local crypto/JWT/cache/exchange implementation, keep exporter schemas/metrics/poll scheduling. Its read-only policy should be `{ repositories: [repoName], permissions: { actions: 'read' } }`, plus only the API permissions actually needed. Architecture C separately prototypes that cutover. A sketch replacing the current `getInstallationToken` is:

   ```ts
   // Initialize once per configured App identity/key path (not per repository).
   const app = yield* makeGitHubApp({
     identity: { clientID: auth.clientID },
     privateKey: Redacted.make(yield* fs.readFileString(auth.privateKeyPath)),
   }, { consumer: 'gh-ci-exporter' })
   const token = yield* app.token({
     installationID: auth.installationIDs[owner],
     repositories: [repoName], permissions: { actions: 'read' },
   })
   // Existing exporter auth header boundary unwraps once with Redacted.value(token).
   // Prefer app.client(scope) for new APIs so 401 invalidation is shared too.
   ```

3. Compose Ulrike with the dedicated App's issues:write token, then integrate its issue number/cursor and ambiguous-create reconciliation into the existing durable control-service state. The standalone transport and actual layer composition are tested in the dotfiles worktree; server/control wiring is deliberately not activated by an architecture bakeoff. Pin the accepted upstream revision in dotfiles composition and regenerate dependency locks for adoption. Prototype package manifests/Buck source projections are refreshed; production locks/member pins stay unchanged because this is a candidate, not a published upstream dependency.
4. **Keep Rust hy-forge and Go runner-scaler minters.** Do not embed a TS runtime or remote broker merely to deduplicate ~JWT/token logic across languages. Their consumers/trust boundaries already exist. Align the protocol contract (skew, JWT TTL, mandatory scope where possible, refresh, secret delivery, no unsafe write replay) and reuse the same fixture cases in those languages. Architecture A replaces the canonical TS implementation and its vendored TS copy, not all three language implementations.
5. **Keep CI token creation via actions/create-github-app-token** and effect-utils `githubAppInstallationTokenStep`. Workflow identity/permissions/repository inputs should follow the same manifests/policies; Actions already has the appropriate lifecycle and masking. Do not mint another long-running service token inside CI helper code.

Upstream only the mechanism: schemas, Redacted key/token API, signing, scoped cache, typed errors, HttpClient layer, and conformance tests. Ulrike's issue text, Johannes reply prefix, comment cursor, and private-repository policy remain in dotfiles. Nix host/1Password inventory also remains with the owning repo. No universal bot inventory or broker is introduced.

## Dedicated Ulrike App

Use the dedicated `ulrike-it` App chosen in Axe Q87 (`3mjvb3`): selected repository schickling/dotfiles, issues:write plus GitHub's implicit metadata:read, no contents/pull_requests/actions/administration grants. Polling comments fits issues permission; request tokens explicitly ask only issues:write for dotfiles. GitHub cannot restrict an issues:write token to one issue or a comment prefix, so the control-service code still constrains its operations and accepted reply author.

Do **not** reuse hymerge merely because it already has issues:write. Down-scoping a token reduces the damage of a stolen token, but a stolen hymerge PEM can mint contents/pull_requests/actions tokens for the installation. Copying that PEM to dev5 would extend hymerge's compromise boundary into a service handling private family requests. The dedicated App limits the key's ceiling, gives bot replies the right identity, and makes revocation independent. The price is another App registration, key/installation record, and rotation recipient.

## Evidence

All fixtures bind a dynamically allocated loopback HTTP port, use real RSA signing with keys generated in the test, and never contact GitHub. Commands ran with `CI=1` and `nice -n19` on dev5; no formatter, full repo gate, Nix build, production restart, secret retrieval, push, PR, or App mutation was run.

- `CI=1 nice -n19 bun node_modules/vitest/vitest.mjs run packages/@overeng/utils/src/node/github-app.integration.test.ts --config /tmp/github-app-effect-a/vitest.config.ts`: **3 passed**. Signature/iat/exp/iss, concurrent cache, 60-second refresh, body down-scoping, scope separation, mint/API 401, no replay, empty permissions, off-origin rejection.
- `CI=1 nice -n19 bun node_modules/vitest/vitest.mjs run packages/@overeng/gh-ci-utils/src/node/GitHubClient.integration.test.ts --config /tmp/github-app-effect-a/vitest.config.ts`: **1 passed**. Existing App-configured gh-ci-utils uses shared token mint/cache and sends installation auth.
- Focused existing gh-ci-utils suites `test/cliTokenFallback.test.ts`, `test/GitHubClient.test.ts`, `test/GitHubClientLogs.test.ts` with the same Vitest config: **23 passed**.
- In the dotfiles candidate, `CI=1 nice -n19 bun node_modules/vitest/vitest.mjs run flakes/ulrike-it/src/github-issues.integration.test.ts --config /tmp/github-app-effect-a/vitest.config.ts`: **1 passed**. Private repository lookup, exact tray title/body issue creation, token reuse, multi-page comments, Johannes-only `Für Ulrike:` extraction, durable cursor return, public-repo refusal.
- `CI=1 nice -n19 bun node_modules/typescript/bin/tsc -p /tmp/github-app-effect-a/tsconfig.json`: **passed (exit 0)**. Strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noEmit; includes auth module/test, gh-ci client/integration test, and Ulrike module/test with the candidate subpath pointed at source. The initial run found generic inference in HttpClient.makeWith; fixed with explicit type parameters. The final combined upstream run passed **27 tests in 5 files**, and the dotfiles run passed **1 test**. Focused checks do not claim full repository typechecking or package/Nix build readiness.

The focused dependency environment is a scratch `/tmp/github-app-effect-a` package with exact repository versions: effect/@effect/platform-node/@effect/vitest 4.0.0, vitest 5.0.3, TypeScript 7.0.2, @types/node 26.5.0. Worktrees' ignored node_modules link there; workspace packages link to this candidate. The temporary test config does not collect the whole repository. Package/Buck projections were regenerated from their existing generator outputs, not hand-patched.

## Weaknesses and Johannes decisions

- Every process owns an App private key. It can ignore requested policy and mint the full App/installation ceiling. This library improves reuse and correct composition, not central security enforcement; a broker has a stronger key-isolation story but adds fleet availability/auth/protocol operations.
- No cross-process token sharing. Each service may exchange hourly, and each key rotation needs all recipients restarted. Failures are local rather than fleet-wide, but startup/exchange traffic is duplicated.
- Per-scope single-flight now shares concurrent successes and failures without serializing unrelated scopes. Refresh time is sampled after lock acquisition and after HTTP completion. Cache scope count is bounded by trusted consumer configuration, not an enforced library limit.
- The utils install closure is broader than this module needs. Decide whether a dedicated publishable package is worth the package/generator/versioning work.
- gh-ci-utils now uses `app.client(scope)` end to end for REST reads/writes, GraphQL and GitHub log redirects. Its 401s invalidate the rejected token without replaying writes; the off-origin storage fetch remains unauthenticated. The explicit CLI fallback for owners lacking installations is unchanged.
- A private-repository preflight cannot atomically guarantee privacy if an administrator makes the repo public between lookup and creation. Repository administrative policy must prohibit that race; for stronger segregation use a dedicated permanently private support repository. Existing repo readership and notification/email copies also govern who can see family request text.
- The poll cursor is comment-ID based; editing an old comment after the cursor will not deliver it as a new reply. Decide whether replies are append-only or edited-comment detection is required. Login matching is suitable for this prototype; production can pin Johannes's immutable user ID.
- Issue creation is not exactly-once. A network failure after GitHub accepts a POST is ambiguous; the real control integration must store a stable request marker and reconcile before retries. This candidate intentionally proves the transport, not an invented state protocol.
- Real Ulrike App identity/installation/key binding is not provided. Johannes must create/install/grant it and approve the dedicated App ceiling, retention/readership policy, operational rotation/revocation ownership, and whether this in-process design or a central broker wins. Existing caller policy permissions must be aligned before the gh-ci cutover.

## Consolidation hardening contract

`makeGitHubApp` and `GitHubApp.layer` require a stable `consumer` option. Installation ID, normalized repository set and normalized permission set identify each cache entry; App identity and key are isolated by service instance. The default early-refresh window is 60 seconds (`refreshMarginSeconds` is a positive integer). Failed/interrupted flights are removed so the next explicit operation can recover. A late 401 only evicts entries containing the rejected token value, not a replacement.

Spans `github-app.make`, `github-app.token`, `github-app.mint`, `github-app.request`, `github-app.invalidate` and `github-app.rate-limit` model the meaningful boundaries. App client ID, installation ID, stable consumer and concise `span.label` identify operations. No credentials, response body or PEM exception is retained in auth errors or auth telemetry. The process owns OTel export/layer configuration.

Metrics use bounded App/installation/consumer attributes, never repository/scope/token labels:

- `github_app_mints_total`: counter of attempted installation token mints.
- `github_app_mint_failures_total`: counter of typed mint failures (interruption is not an auth failure).
- `github_app_token_expiry_seconds`: gauge of earliest cached expiry for the installation, Unix seconds; zero when its cache is empty.
- `github_app_rate_limit_remaining`: gauge of last observed remaining budget, separately labeled by GitHub resource (`core`, `search`, `graphql`, `integration_manifest`, `code_search`). Missing/invalid headers leave the last observation unchanged.

`GitHubClient.layer({ consumer, permissions })` lets gh-ci-exporter reuse the upstream API with only `actions:read`; interactive gh-ci-utils keeps its actions-write policy. The exporter adds date-bound completed-run paging; shared job schemas retain optional `created_at`, and the exporter validates that its queue-wait field is present. The entire vendored exporter API/auth client is removed in the paired dotfiles prototype, not just its signer.

LiveStore's `scripts/src/commands/github.ts:331-364` signs an **App JWT** for `GET /app`, not an installation token. Its `check` command consumes it at lines 415-416. Installation clients are therefore not a drop-in: reuse would need an App-authenticated read client/JWT API with the same safe origin, typed-error and observability contract, then remove its signer/fetch wrappers. No LiveStore file is modified.

The Ulrike transport at dotfiles `b4c800ff0c`, `flakes/ulrike-it/src/github-issues.ts:4,21-24`, already consumes `GitHubAppHttpClient`. Later adoption only needs the accepted package pin, a stable `consumer: 'ulrike-it'` on its `GitHubApp.layer` composition, dedicated App identity/redacted key and existing dotfiles/issues-write scope, plus its existing test/layer wiring. This does not unblock or alter Ulrike's minimal delivery path.
