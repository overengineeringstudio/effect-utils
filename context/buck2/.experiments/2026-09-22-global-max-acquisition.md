# CAS-native dependency acquisition and product-as-FOD

Date: 2026-09-22

Host class: x86_64-linux development host. Buck2 pin:
`2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`; bazel-remote
2.6.2; Determinate Nix 3.22.3 / Nix 2.35.2.

## Question

Can one digest serve as the archive identity for Buck dependency acquisition,
remote CAS transfer, and Nix fixed-output fetches, and can a trusted Buck-built
product cross into Nix without a sandboxed Nix build invoking Buck? Does one
archive-digest change invalidate only its consumer?

This is mechanism evidence. The architecture recommendation and proposed VRS
amendments were reviewed in the private oversight report and are now recorded
in decision 0038.

## Method

1. Select `@adobe/css-tools@4.5.0` from the checked-in SHA-256 sidecar. Download
   its registry archive and independently verify SHA-256
   `e3fcb785c85d490882e866b885e570ed5d0ddbbea1149d4fa2d9a73c4f2247bc`.
2. PUT the 43,871-byte archive to the deployed private bazel-remote HTTP CAS at
   `/cas/<sha256>`. Add a scratch `pnpm.archive_origin` config path to
   `pnpm_package`: the existing `actions.download_file` uses
   `<origin>/cas/<sha256>` while retaining the checked-in SHA-256.
3. Build the real fetch target in a fresh isolation and hash its output. Build a
   clean `pkgs.fetchurl` FOD from the same URL with substituters disabled.
4. Realize the prior prototype's 671 individual archive FODs and seed their
   digest-addressed bytes into the private CAS. Build the real `genie` product
   with the CAS origin, a fresh `file_watcher=none` isolation, local execution,
   and remote cache disabled. Compare the module digest with the prior
   Nix-store-backed and standalone builds.
5. Append one byte after the gzip stream of the Adobe fixture, PUT the new
   43,872-byte digest, and temporarily change only that generated declaration.
   Rebuild two package targets, then the warm `genie` target. Restore the
   generated declaration afterward.
6. PUT the resulting 6,320,572-byte `genie.js` by digest and fetch it as a clean
   `pkgs.fetchurl` FOD with substituters disabled.

Heavy first builds used `buck2-heavy.sh`. The small warm invalidation and 6 MiB
FOD probes ran directly after the shared admission lock itself blocked the
wrapped probe. No service configuration changed.

## Result

| Probe | Result |
| --- | --- |
| CAS PUT of real pnpm archive | HTTP 200; server accepted the digest key |
| Buck `pnpm_package` fetch target | pass; output SHA-256 exactly matched the sidecar |
| Nix FOD from the same archive URL | pass with substituters disabled; exact SHA-256 |
| Archive publisher seed | 670 missing blobs, 645,360,942 bytes, 38.815 s; one blob already present |
| Fresh CAS-backed `genie` | pass; 587 local commands, 0 cached/remote, 50 MiB HTTP, 583.24 s under host pressure |
| `genie.js` parity | SHA-256 `4e5febf7ce9948a6e4e8d4d8e1cad111f2fecffd542182caf3111a93744678fe`, equal to prior sandbox and standalone results |
| Two-package digest mutation | one local command; unrelated package ran zero commands; 0 network bytes reported |
| Warm `genie` digest mutation | one local command; success in 2.00 s; final product digest unchanged |
| `genie.js` as Nix FOD | pass with substituters disabled; exact 6,320,572-byte payload digest |

The altered archive has the same gzip/tar payload plus one trailing byte. It is
not a claim that a semantic package change leaves the product unchanged. It is
a controlled key mutation proving that the archive identity is per declaration:
Buck re-executed the changed archive's extraction and no unrelated command.

The 583-second fresh result is not a performance baseline. It deliberately
forced local, cache-cold execution during the recorded shared-host resource
pressure. The unchanged target had previously completed in 27 seconds inside a
Nix sandbox; BUCK-R07 needs a controlled warm-cache measurement.

## Pinned-source interpretation

At `be6971d`, `DownloadFileAction.inputs()` is empty and execution returns
`ActionExecutionKind::Deferred` or `Simple`, never `Command`. With SHA-256 and
known size, the daemon declares HTTP materialization without network I/O; without
size it first obtains `Content-Length` by HEAD. First materialization streams and
hashes the bytes. Remote workers do not execute the URL fetch: command-action
input staging addresses the blob by digest in CAS and asks the invoking daemon
to materialize/upload only when that digest is absent. `download_file` neither
reads nor writes the action cache.

This means a CAS-native archive is compatible with remote command execution but
is not itself a remotely executed command. Production metadata should carry
both SHA-256 and byte size so declaration is network-free.

## Conclusion

The global maximum is a durability-qualified hybrid: Buck acquires each
third-party archive directly from its trust-tier CAS by SHA-256 and size, while
trusted Buck automation publishes each portable product as a digest-pinned FOD
for Nix consumers. Registry archives remain recovery authority until the CAS
has a retention-proven durable backend. Consumers fail closed on a product miss
instead of invoking Buck through a second Nix producer.

## Falsifiers

- A corrupt body served at the declared URL that materializes successfully
  falsifies consumer-side SHA-256 enforcement.
- A second archive-digest mutation that executes an unrelated package command
  falsifies narrow invalidation.
- A pinned-source path showing `DownloadFileAction` submitted through the remote
  command executor falsifies the client-side acquisition conclusion.
- A clean product FOD that cannot reproduce the published payload digest
  falsifies product-as-FOD byte identity.

## Not established

- Remote execution is not deployed, so no live worker consumed the seeded
  archive. The pinned-source staging path, not a live RE run, grounds that part.
- Public tier TLS, anonymous reads, authenticated writes, and trust separation
  await dotfiles#2980. All live writes used the private tailnet service.
- The raw `genie.js` FOD proves product payload transport and parity, not the
  complete descriptor/archive validation wrapper or private-product auth path.
- Retention and restore of CAS archive or product bytes are not established;
  the deployed cache remains an evicting accelerator.
- Darwin and Linux aarch64 parity and a controlled BUCK-R07 benchmark remain
  unmeasured.

## VRS Impact

Supports a new decision separating two boundaries: CAS-native, per-digest
third-party archive acquisition for Buck contexts; digest-pinned product FODs
published by trusted Buck builders for Nix consumers. It requires explicit
amendments to the vision's product-miss bullet, BUCK-R06/R17, BRIDGE-R08, and
decision 0037. EXEC-R04 and BUCK-R08 remain unchanged and are strengthened by
the measured one-command invalidation and removal of the 646 MiB per-product
archive input closure.
