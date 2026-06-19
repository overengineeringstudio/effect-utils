# Vision — Notion native `status` schema as code

Operator-facing Notion databases use the native `status` property as part of
their product contract, not as cosmetic view state. The set of status options
(and the typed unions generated from them) is something engineers reason about
and depend on in code. Today that field is the one undocumented manual exception:
its options are clicked into existence in the Notion UI, while everything around
it — read schemas, typed option unions, drift checks — is code-owned.

The goal is to bring native `status` options under the same code-owned,
observe-first, fail-closed discipline already used for page-value writes, **to
the extent the Notion API allows it**, and to make every divergence that the API
_cannot_ close loudly visible in code review and CI rather than silently
drifting.

Concretely, success means:

- A status property declared in code can have its missing options created in
  Notion from a single reviewed command, safely and idempotently.
- Any divergence between the code-owned schema and the live Notion database —
  including the parts the API cannot write — is detected and can fail CI.
- An engineer never has to wonder whether the typed `status` union in code still
  matches the live database.
- The system never silently mutates or deletes anything: it acts only on
  explicitly opted-in properties, only via operations proven safe, and reports
  the rest with actionable guidance.

This vision is bounded by an external reality (see `requirements.md` A1): the
Notion API is, as of version 2026-03-11, effectively **add-only** for `status`.
The vision is therefore deliberately asymmetric — full _detection_, narrow
_convergence_ — and stays honest about that ceiling rather than pretending to a
convergence the platform does not support.

Out of scope: Notion **view** convergence, and convergence of `status` **groups**
or existing-option colors/names (the API does not support writing them; they are
detect-and-report only).
