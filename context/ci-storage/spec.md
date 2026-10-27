# Spec: CI storage

This document specifies the reusable `ci-storage` CLI, canonical archive protocol, and thin GitHub Actions interface. It builds on the scoped contract requirements below; repository workflow admission and generated authority remain defined by [repository CI](../ci/spec.md).

## Status

Active.

## Scope

**Defines:** deterministic packing, repository-scoped artifact references and keys, verification, atomic extraction, file-supplied transport capabilities, and action inputs and outputs.

**Does not define:** workflow adoption, credential issuance, storage provisioning, object discovery, retention enforcement, garbage collection, or general-purpose build-cache protocols. The caller supplies an already authorized URL file; this library does not implement an authorization broker.

## Contract requirements

- **R01 Canonical identity:** Identical selected paths and file bytes produce identical archive bytes, independent of input ordering, source timestamps, ownership, and permissions.
- **R02 Verified publication:** Extraction exposes a destination only after both the archive digest and complete manifest have been verified. Upload actions publish references only after a successful upload.
- **R03 Closed archive format:** Readers reject paths, entry types, metadata, and contents outside the canonical format, including all symbolic links.
- **R04 Scoped identity:** References contain repository, SHA-256, and retention class; object keys derive solely from these fields.
- **R05 Capability secrecy:** Presigned URLs enter through files, never command-line URL values, outputs, or diagnostics.
- **R06 Shared implementation:** Actions invoke the same CLI used directly; they do not implement a second packer, verifier, extractor, or transport.

## Components and flow

```text
allowlisted paths -> pack -> canonical archive -> put -> object
                       |                         |
                       +-> ref + sha256 + key    +-> publish ref

ref + object -> get -> local archive -> verify -> temporary tree -> rename
```

The executable is `ci-storage`, implemented in `rust/ci-storage`. The composite action is `.github/actions/ci-storage/action.yml`; workflow rendering lives in `genie/ci-workflow/storage.ts`. The executable owns R01–R05; the action and renderer preserve those contracts without duplicating archive logic (R06).

## Reference and key protocol

```json
{
  "repo": "example/project",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "retention": "handoff"
}
```

The reference is a JSON object with exactly these fields:

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo`      | Repository identity `OWNER/REPO`, with exactly two nonempty components matching `[A-Za-z0-9_.-]+`; components exactly `.` or `..` are rejected. Case is preserved. |
| `sha256`    | Exactly 64 lowercase hexadecimal characters: SHA-256 of the entire compressed canonical archive, not the manifest or uncompressed tar.                             |
| `retention` | Exactly `diagnostic`, `handoff`, or `release`. Unknown values are rejected.                                                                                        |

No reference field contains an endpoint, credential, local path, or provider-specific object ID. The retention field selects the storage namespace; it does not itself enforce deletion or expiry. Repository and retention are scoping metadata, not additional inputs to the archive digest (R04).

The effect-utils project owns the repository-local `ci/v1` object-key namespace. It is not a registered URI scheme or a globally federated identifier. Keys use literal forward slashes and this case-sensitive layout:

```text
ci/v1/<owner>/<repo>/<retention>/sha256/<digest>.tar.gz
```

`<owner>/<repo>` is the reference's `repo`; `<retention>` and `<digest>` are the corresponding reference fields. No caller-selected prefix, alternate algorithm, or restore-prefix lookup is accepted. Different repositories or retention classes do not share an object key even when their archive digest matches. Breaking archive changes require a new protocol version rather than reinterpretation of `ci/v1`.

| Example                                                          | Meaning                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ci/v1/example/project/handoff/sha256/<64-lowercase-hex>.tar.gz` | Valid key shape; angle-bracket text stands for the digest, not literal key bytes. |
| `repo: "example/project", retention: "diagnostic"`               | Valid repository/class pair.                                                      |
| `repo: "../project"`                                             | Invalid repository identity.                                                      |
| `retention: "temporary"`                                         | Invalid class.                                                                    |
| Uppercase digest or a digest prefixed by `sha256:`               | Invalid digest encoding.                                                          |

## Canonical archive

```text
one gzip stream
  one canonical GNU tar stream
    1. .ci-storage-manifest.json     regular file, canonical manifest JSON
    2. first selected file          regular file
    3. next selected file           regular file
    ...                            sorted by archive path
```

This section implements R01 and R03.

### Selected paths

`pack` takes explicit file or directory paths relative to its working directory. Paths are clean UTF-8, at most 100 bytes, and slash-separated sequences of normal components: no absolute roots, empty components, `.` or `..`, or platform-specific path escape syntax. Archive paths preserve this working-directory-relative layout, including the selected directory name; they are not rebased to each input's basename.

Directories are traversed recursively. Only regular files are included; empty directories are omitted. Overlapping input selections are deduplicated by archive path. Symbolic links are rejected, including links in directory parents; they are neither followed nor archived. Non-regular source objects are rejected. The root path `.ci-storage-manifest.json` is reserved and cannot be supplied as a payload file.

Payload entries and manifest rows are sorted by their UTF-8 archive path. Input order, traversal order, source permission bits, ownership, and timestamps do not affect the result. Two different selected paths with identical bytes remain two entries.

### Manifest

```json
[
  {
    "path": "dist/output.txt",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 0
  }
]
```

The first entry is exactly `.ci-storage-manifest.json`. Its body is a JSON array, with one row per payload file and no row for the manifest itself. Each row has exactly `path`, `sha256`, and `size`: a valid archive path, lowercase SHA-256 of that file's raw bytes, and its nonnegative integer byte length. Rows follow payload-entry order. Unknown fields, duplicate paths, mismatched lengths or hashes, and missing or extra entries are errors.

Writers serialize the array as compact UTF-8 JSON with row fields in the order `path`, `sha256`, `size`, no formatting-dependent whitespace, and no trailing newline. The canonical encoder and reader use the same representation; semantically equivalent but differently encoded manifests are not alternate canonical encodings.

### Tar and gzip metadata

| Property                      | Canonical value                                                    |
| ----------------------------- | ------------------------------------------------------------------ |
| Tar headers                   | GNU headers; logical payload entry type regular file only.         |
| File mode                     | `0644`, including the manifest.                                    |
| UID, GID, modification time   | `0`.                                                               |
| User and group names          | Empty.                                                             |
| Entry size                    | Actual body length.                                                |
| Directory entries             | Omitted; extraction creates required directories with mode `0755`. |
| Gzip compression              | Default compression, level `6`.                                    |
| Gzip header modification time | `0`.                                                               |
| Gzip operating-system field   | `255`.                                                             |
| Gzip filename and comment     | Absent.                                                            |

Canonical encoding is the CLI's GNU tar construction followed by its fixed gzip encoder. Verification reconstructs this encoding and compares its complete compressed-byte digest with the expected archive digest, not merely the decoded entries. A differently compressed stream, changed header, trailing content, or otherwise noncanonical representation fails even if all file hashes match. Changes to the encoder must preserve `ci/v1` byte compatibility.

Canonical archives contain no extension records. The 100-byte path limit fits each path directly into its GNU header, so writers never emit GNU long-name or long-link records. Readers use raw header iteration and reject GNU long-name, GNU long-link, local PAX, and global PAX records before reading their bodies.

### Resource limits

Packing, verification, and extraction enforce fixed protocol limits; callers cannot raise them through command-line flags.

| Resource                        | Maximum                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Payload entries / manifest rows | 10,000 (plus the single manifest tar entry).                                                       |
| Archive path                    | 100 UTF-8 bytes.                                                                                   |
| Manifest body                   | 16 MiB.                                                                                            |
| Individual payload body         | 1 GiB.                                                                                             |
| Sum of payload body sizes       | 4 GiB.                                                                                             |
| Complete decoded gzip stream    | 4 GiB + 64 MiB, including tar headers, padding, manifest, end markers, and trailing decoded bytes. |

MiB and GiB mean powers of 1024. Manifest entry counts, per-entry sizes, and the overflow-checked total are validated before payload materialization. Packing checks these limits before hashing payloads or emitting an archive. A byte-budget reader wraps the gzip decoder before the tar parser sees any decoded bytes; exceeding its budget is an explicit `decoded archive byte limit exceeded` error, never a successful truncated stream. Verification drains the decoder after tar end markers so trailing decoded data cannot bypass the budget. Limit violations exit with status `1`, clean temporary state, and publish no destination or reference.

### Rejected entries

| Input                                                            | Reader behavior                 |
| ---------------------------------------------------------------- | ------------------------------- |
| Symlink, including an internal/non-escaping link                 | Reject.                         |
| Hardlink                                                         | Reject.                         |
| Device, FIFO, socket, directory entry, or unknown tar entry type | Reject.                         |
| GNU long-name/long-link or PAX extension record                  | Reject before reading its body. |
| Absolute path, traversal, or noncanonical path                   | Reject.                         |
| Duplicate entry or duplicate manifest path                       | Reject.                         |
| Payload not present in the manifest                              | Reject.                         |
| Manifest row without its exact payload entry                     | Reject.                         |
| Manifest absent, repeated, or not first                          | Reject.                         |
| Per-file size/hash mismatch or archive digest mismatch           | Reject.                         |
| Valid contents with noncanonical ordering, metadata, or encoding | Reject.                         |

## CLI

```text
ci-storage pack PATHS... --retention CLASS --repo OWNER/REPO --out FILE
ci-storage verify ARCHIVE --ref JSON
ci-storage extract ARCHIVE --ref JSON --dest DIR
ci-storage put ARCHIVE --url-file FILE
ci-storage get --url-file FILE --out FILE
```

`--ref` takes the reference JSON object itself, not a reference filename or a URL. `--url-file` takes a local file containing the authorized transport URL, never the URL itself (R05).

| Command   | Successful behavior                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack`    | Validates the allowlist, writes the canonical archive to `--out`, computes its compressed-byte digest, and prints one JSON result to stdout.              |
| `verify`  | Validates the reference, archive digest, canonical encoding, complete manifest, and all payloads using temporary storage; publishes no destination files. |
| `extract` | Performs all `verify` checks before atomically publishing a newly created destination tree.                                                               |
| `put`     | Uploads bytes by HTTP PUT with `If-None-Match: *` using only the supplied URL capability; succeeds only for a successful creation response.               |
| `get`     | Retrieves bytes by HTTP GET using only the supplied URL capability and writes `--out`; extraction and reference verification remain separate operations.  |

`pack` prints the following shape, with equal top-level and nested SHA-256 values and a key derived from the reference:

```json
{
  "ref": {
    "repo": "example/project",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "retention": "handoff"
  },
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "key": "ci/v1/example/project/handoff/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.tar.gz"
}
```

These fields describe one artifact; disagreement is not an alternative identity. A successful local `pack` is not proof that the object has been uploaded. `put` and `get` do not infer repository or retention metadata from URL text and do not issue capabilities or implement object discovery.

`put` does not overwrite an existing object. HTTP `412 Precondition Failed` fails closed because a method-scoped PUT capability cannot verify the existing object's digest. An ETag or object-presence check is not proof of SHA-256 equality. This interface does not accept an existing object as successful without verification and does not automatically broaden PUT authority into GET authority.

### Verify-before-extract and atomic publication

```text
validate ref -> hash archive -> create sibling temporary directory
  -> validate manifest and materialize payloads into the temporary tree
  -> verify every payload and reconstruct canonical archive digest
  -> rename verified temporary tree to destination
```

This sequence implements R02 and R03. The destination must not already exist. The temporary directory is created in the destination's parent so the final publication is a same-filesystem rename. No payload is written into the destination before complete verification. Materialization uses only validated regular-file paths, fixed file mode `0644`, and required directory mode `0755`.

A validation, write, or rename error fails the operation without publishing a partially populated destination; temporary extraction state is cleaned up. Existing destination contents are never merged with or overwritten by extraction. Failed downloads cannot become trusted artifacts: consumers must invoke `verify` or `extract` against the expected reference.

### Exit status and URL redaction

| Exit code | Meaning                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `0`       | Command completed successfully, including explicit help requests.                                                        |
| `1`       | Operational or validation failure, including filesystem, transport, reference, checksum, archive, and extraction errors. |
| `2`       | Command-line usage error, including missing required arguments or an unsupported command/option.                         |

Machine-readable `pack` output goes to stdout; diagnostics go to stderr. Presigned URLs are capabilities: the CLI and action must not print their contents, host, path, query string, or reflected HTTP error body. Transport error reporting must not forward a client-library error that embeds the request URL. Commands must not enable shell tracing, verbose HTTP output, or URL-bearing command-line arguments. Reference JSON, digest, and derived object key are safe protocol outputs; they are not transport credentials.

## Thin GitHub action

```text
upload:   paths -> CLI pack -> CLI put -> emit ref and sha256
download: ref -> CLI get -> CLI extract -> verified destination
```

The action is a wrapper around the CLI, not an alternate implementation (R06). Upload must complete before the action emits `ref` or `sha256`; download must fail if reference validation, download, verification, or extraction fails. URL-file inputs name caller-provided files; neither mode accepts a presigned URL value directly. Action outputs never contain the URL or its file contents.

The upload reference can be passed through ordinary step/job outputs to the download invocation. Reference transport does not confer GET/PUT authority; each invocation independently receives the appropriate URL file. The action does not fall back to GitHub artifact storage or discover an object by artifact name.

### Inputs and outputs

| Input          | Upload                                           | Download                                      |
| -------------- | ------------------------------------------------ | --------------------------------------------- |
| `mode`         | Required: `upload`.                              | Required: `download`.                         |
| `paths`        | Required JSON array of allowlisted path strings. | Unused.                                       |
| `retention`    | Required retention class.                        | Carried in `ref`.                             |
| `repo`         | Defaults to `${{ github.repository }}`.          | Carried in `ref`.                             |
| `ref`          | Produced by packing, not supplied.               | Required reference JSON object.               |
| `destination`  | Unused.                                          | Required, nonexistent extraction destination. |
| `put-url-file` | Required path to PUT-capability file.            | Unused.                                       |
| `get-url-file` | Unused.                                          | Required path to GET-capability file.         |

Only `mode` is unconditionally required by the action metadata; mode-specific requirements are checked before performing that mode's work. There is no generic action `url-file` input. Successful upload emits `ref` as compact JSON and `sha256` as lowercase hexadecimal, only after `put` succeeds. Download emits neither output.

The action resolves a single self-contained Nix-delivered binary from its checked-out source's `.#ci-storage` package. Its Nix closure may be dynamically linked; it requires no Bun or JavaScript runtime bootstrap. Resolution disables local builds and remote builders, requiring the configured trusted binary substitute to exist rather than compiling the CLI in the action.

### Workflow rendering

```ts
type ArtifactClass = 'diagnostic' | 'handoff' | 'release'
type ArtifactRef = {
  readonly repo: string
  readonly sha256: string
  readonly retention: ArtifactClass
}

artifactUploadStep(args: {
  id: string
  paths: readonly string[]
  retention: ArtifactClass
}): WorkflowStep

artifactDownloadStep(args: {
  ref: string
  destination: string
}): WorkflowStep
```

Both helpers render `uses: './.github/actions/ci-storage'` and therefore require that local action to be checked out. Upload JSON-encodes `paths`, forwards `retention`, selects `${{ github.repository }}`, and supplies `put-url-file` from `${{ env.CI_STORAGE_PUT_URL_FILE }}`. Download forwards `ref` and `destination` unchanged and supplies `get-url-file` from `${{ env.CI_STORAGE_GET_URL_FILE }}`. The helper does not resolve reference expressions or issue URL capabilities; callers supply these environment file paths before execution.
