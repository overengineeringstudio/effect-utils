# 0038 Digest Origins for Acquisition

Status: accepted

Accepted 2026-09-22 (decision q62, confirmed by Johannes).

## Context

Every Buck context needs the same immutable third-party archive identity without
copying one prepared dependency tree into each worktree. The registry path is
durable but repeatedly transfers the same bytes, an aggregate Nix projection
broadens invalidation, and an evicting CAS cannot be the sole recovery
authority. Decision 0037 separately requires publication to remain an
optimization: a Nix substitution miss still reconstructs the product through
the pinned Buck graph.

The 2026-09-22 acquisition and Nix-store experiments established three useful
properties. Buck `download_file` verifies a declared SHA-256 and can declare the
byte size without a preliminary request. A digest-addressed CAS and the npm
registry yield identical archive bytes. A Nix sandbox can run the checked-in
Buck graph when fixed-output archives are projected through a verified copy
action, with no synthetic root or prepared `node_modules` adapter.

## Evidence and Argument

- The CAS prototype built the complete 21-product graph with 587 command
  actions after replacing registry URLs with digest URLs, without changing
  generated product bytes.
- The Nix-store-view prototype built the same `//packages/@overeng/genie:dist`
  target inside a Nix sandbox and matched the standalone Buck output exactly.
- The old from-source adapter changed one of the 21 products byte-for-byte and
  required synthetic rules that duplicated the repository graph. Treating that
  adapter as recovery authority would preserve the wrong abstraction.
- SHA-256 alone authenticates bytes but not why those bytes are permitted. The
  manifest's identity, canonical URL, lock SHA-512, size, and classification
  bind review intent to acquisition and prevent a trust-tier seeder from
  laundering an otherwise valid digest.
- Different source URLs legitimately produce different fetch action keys. The
  useful equivalence is verified content and downstream product identity, not
  an artificial equality between acquisition requests.

## Options

| Option | Tradeoff | Outcome |
| --- | --- | --- |
| Digest origin per Buck context plus per-digest Nix FODs | Keeps acquisition local to each context, preserves exact verification, and lets the sandbox execute the real graph. | Accepted |
| One aggregate prepared dependency tree | Fewer fetch actions, but broad invalidation, duplicated worktree materialization, and the failed synthetic adapter preserve the wrong build boundary. | Rejected |
| Registry only | Correct recovery path, but repeats network transfer and cannot exploit the existing digest CAS. | Rejected |
| CAS only | Fast while present, but eviction removes recovery authority and availability depends on one unproven retention tier. | Rejected |

## Decision

1. Genie generates `pnpm-lock.sha256.json` as the reviewed archive manifest.
   Every row binds the package identity, canonical registry URL, lockfile
   SHA-512 integrity, derived SHA-256, byte size, executable metadata, and
   public/private classification. Generation verifies SHA-512 before deriving
   SHA-256 and size; freshness binds every field to the lock projection.
2. Each Buck `pnpm_package` declares the canonical URL, SHA-256, and byte size.
   Without an archive origin, client-side `download_file` fetches the canonical
   registry URL. With `archive_origin.url_prefix` configured, a local acquisition
   action first requests `<prefix><sha256>` and falls back to the canonical
   registry URL **only** on a direct CAS HTTP 404. CAS redirects are errors;
   registry redirects are followed manually only while every hop passes the
   same approved public HTTPS origin policy as the manifest. Response-header
   and overall transfer deadlines bound acquisition. The action aborts oversized
   streams immediately and publishes an atomic rename only after SHA-256 and
   byte-size verification; other CAS errors and mismatched bytes fail closed.
   Buck's `download_file` accepts only one URL, so it cannot implement this
   fallback itself. Downstream actions consume the verified content artifact,
   converging on the same digest regardless of the supplying origin.
3. Archive acquisition is local rather than a remotely executed command.
   Result-producing consumers remain eligible for REAPI and receive the same
   immutable content digest. BUCK-R17 applies to those command actions.
4. A protected-main seeder verifies the canonical registry response against the
   manifest's SHA-512, SHA-256, size, URL, and package identity before an
   idempotent CAS PUT. It reads the destination trust tier from configuration.
   A public tier accepts only rows classified public; a private tier may accept
   either. Pull-request jobs never receive write credentials.
5. The Nix source fallback realizes one fixed-output archive per digest and
   projects the selected archive set through `nix_store.root`. Buck copies and
   re-verifies each digest and size, then runs the same checked-in graph and
   capability projection as a standalone build. The Nix-store path and digest
   enter the sandbox acquisition action key; product output identity remains
   the graph result.
6. Product publication remains an optimization under decision 0037. A cache
   miss executes the pinned source fallback and must reproduce the recorded
   product digest. This decision replaces only 0037's prepared-dependency-tree
   mechanism, not its substitution, publication, provenance, or recovery
   requirements.

## Consequences

- BUCK-R06 names command-action AC reuse and digest/size CAS acquisition as
  distinct mechanisms. BUCK-R17 excludes client acquisition while retaining
  remote execution for every result-producing command action.
- The source recipe deletes its synthetic root, toolchain and dependency stubs,
  prepared dependency projection, package-rule rewrites, and coupling to the
  `gh-ci-utils` pnpm FOD.
- The initial source fallback uses the aggregate lock archive closure because
  the generated product inventory does not yet expose a cheap per-product
  transitive archive set. Each archive is still an individual FOD. Refining the
  retained closure is an optimization; it must not reintroduce an aggregate
  fetch identity.
- The private tailnet CAS is the current trusted acceleration tier. The public
  tier and Namespace route remain gated on dotfiles #2980; no private archive
  may be published there.
- Registry or a separately retention-proven backend remains recovery authority
  for archive bytes. CAS eviction is a reseed event, not data loss.
