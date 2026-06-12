# Keep one VRS with mechanism sections

The v-next redesign introduces two sync mechanisms, but the VRS remains one
top-level document set rather than nested Mirror Sync and Shared Sync subsystem
directories. This keeps the common contracts in one place while allowing
`requirements.md` and `spec.md` to split their sections by mechanism.

## Status

accepted

## Consequences

`vision.md` stays mechanism-agnostic. `requirements.md` names common, Mirror
Sync, Shared Sync, and verification constraints. `spec.md` uses the same
sections for implementation detail. Nested subsystem VRS directories can be
introduced later if one mechanism grows enough independent depth to justify the
navigation cost.
