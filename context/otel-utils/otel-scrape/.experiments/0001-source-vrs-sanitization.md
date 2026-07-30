# Experiment 0001 — Public VRS sanitization

**Hypothesis:** The process-wrapper telemetry design can be moved into effect-utils without carrying private repository, machine, or deployment details.

**Method:** Reviewed the source VRS and issue text, then rewrote the public VRS around stable effect-utils contracts: `@overeng/otel-contract`, `@overeng/utils`, and `@overeng/content-address`.

**Results:**

- Public docs use the `otel-scrape` name.
- Private source paths, machine names, internal issue numbers, and deployment topology were omitted.
- The core design was preserved: wrapper-owned lifecycle spans, structured-output adapters, event/span/metric classification, root-or-join context propagation, and content-addressed profile links.

**Conclusion:** The VRS can safely live in effect-utils as a public contract. Private repository cleanup should remove the superseded source copy and point maintainers at the public effect-utils issue and docs.
