# Experiment 0003 — Profile artifact URI schemes

**Hypothesis:** A pure content-addressed `cas:` profile URI can be as practical as a two-tier `file:`/`artifact:` contract if `otel-scrape` owns a per-run CAS root.

**Method:** Built a disposable Bun prototype in `tmp/artifact-uri-prototypes/` that emits and verifies profile descriptors using `@overeng/content-address`. The prototype compares:

- option A: local `file:` URI plus CI/logical `artifact:` URI and optional `https:` UI link
- option B: `cas:` URI using `@overeng/content-address` fan-out paths under a resolver root

Both options verify bytes through the descriptor's `sha256:` digest and byte length.

Run:

```bash
bun tmp/artifact-uri-prototypes/prototype.ts
```

**Results:**

- Option A works, but embeds transport/location semantics into every descriptor:
  - `file:` is local-only and not portable across machines.
  - `artifact:` needs a run-scoped resolver from logical artifact IDs to CI artifact bytes.
  - Integrity still depends on separately verifying the digest.
- Option B works with a smaller retrieval contract:
  - `cas:` resolves through a generic CAS root keyed by digest fan-out path.
  - CI can upload or expose the CAS root as one artifact tree.
  - Human-facing UI links can stay presentation metadata instead of retrieval identity.

**Conclusion:** Prefer `cas:` if `otel-scrape` writes profile artifacts into a per-run CAS root and every resolver verifies bytes against the descriptor before use. The main caveat is resolver configuration, but that caveat is generic and cleaner than mixing local filesystem paths and CI artifact IDs into profile links.
