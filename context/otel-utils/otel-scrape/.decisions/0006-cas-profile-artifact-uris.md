# 0006 — CAS profile artifact URIs

**Status:** Accepted.

**Context:** Profile artifacts must be linked from spans without putting large profile bytes into OTEL backends. The URI should identify content, not the machine or CI system that happens to store it. The local prototype in `.experiments/0003-artifact-uri-prototypes.md` showed that `cas:` works for local and CI handoff when `otel-scrape` owns a per-run CAS root.

The repo already has reusable descriptor primitives in `@overeng/content-address`: `ContentDescriptor`, `sha256:` digests, byte length, media type, byte verification, and `objectPathForDigest`. It also has a local object-store precedent in Notion Markdown (`.notion-md/objects/sha256/<first-byte>/<rest>.json`). It does not yet have a general reusable CAS store/resolver API.

**Decision:** Profile artifact retrieval URIs use `cas:` with `@overeng/content-address` fan-out paths.

`otel-scrape` writes artifacts into a per-run CAS root. A profile link carries:

- profile type
- `ContentDescriptor` fields (`digest`, `byteLength`, `mediaType`, optional `codec` / `schemaVersion`)
- `uri = "cas:" + objectPathForDigest(digest)`
- optional UI link metadata for humans

The CAS root is resolved from run context, not embedded in each span. Local runs may keep the root on disk; CI runs must upload or expose the root as a single artifact tree. Consumers must verify bytes against the descriptor before use.

**Consequences:**

- Profile links are portable across local and CI contexts because the span does not contain local filesystem paths or CI artifact IDs.
- `@overeng/content-address` should be reused and likely refined into a small general CAS store/resolver abstraction instead of duplicating object-path and verification logic in `otel-scrape`.
- UI/download links are presentation metadata, not retrieval identity.
- The implementation needs one explicit run-level answer to “where is this run's CAS root?” but individual profile descriptors remain location-independent.
