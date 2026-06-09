# Requirements: 06-scheduling

**Role.** Durable self-rescheduling and the narrow recurring-loop primitive
(`Restate.reschedule` / `RestateScheduled.make` / `Restate.pollLoop`), built
entirely on top of the durable clients ([05-clients](../05-clients/requirements.md))
and the deterministic concurrency combinators
([03-effect-runtime](../03-effect-runtime/requirements.md)). It introduces no new
GLOBAL requirement IDs of its own — it composes existing capabilities (R10
clients, R19 deterministic concurrency, R33 awakeables) into a durable-daemon
shape.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). The design rationale is
[../.decisions/0012](../.decisions/0012-self-reschedule.md).
