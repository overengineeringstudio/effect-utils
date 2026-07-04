# 0002 — otel-core is registry-agnostic

**Status:** Accepted.

**Context:** `otel-scrape` owns an `otel_scrape` telemetry registry (span-naming
scheme, attribute keys, profile-link fields). When the exporter, span model, and
trust-gate move into the shared `otel-core` library (decision 0001), a tempting
shortcut is to move the `otel_scrape` registry into core with them, so the core
exporter "knows" the attribute vocabulary. That would make `otel-core` own one
bin's vocabulary and force every other bin's telemetry through it.

**Decision:** `otel-core` is registry-agnostic. The exporter and span model take
**attributes as data** — typed key/value payloads — and encode/emit them without
owning a registry. Each bin supplies its own registry vocabulary at its call
sites: `otel-scrape` supplies the `otel_scrape` registry, the nix adapter
supplies its namespace, and so on. The `otel_scrape` registry stays with
`otel-scrape`; it does not move into core.

This is a different altitude from the weaver-native mandate (decision 0003) and
is fully compatible with it: decision 0003 governs how telemetry vocabulary is
*authored* (weaver `*.contract.ts` seams → generated typed encoder); this
decision governs where the vocabulary *lives* relative to the exporter (with the
bins, not baked into core). The generated encoder produces attribute *data*; the
core exporter consumes that data without knowing which registry produced it.

**Consequences:**

- `otel-core` is reusable by any producer regardless of its attribute
  vocabulary; a new bin does not inherit `otel-scrape`'s registry.
- The exporter has no registry-shaped coupling and no privileged vocabulary.
- Registry ownership stays layered: seams author, the encoder generates, bins
  supply, core emits.
- A single normative statement of this lives in [spec.md](../spec.md#how-the-bins-compose);
  subsystem specs reference it.
