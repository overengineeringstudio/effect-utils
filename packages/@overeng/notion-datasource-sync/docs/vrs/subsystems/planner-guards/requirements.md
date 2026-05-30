# Planner & Guards Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **PLAN-R01 Surface bases (was R21):** Every local write must reference the last-clean base hash for the smallest relevant surface.
- **PLAN-R02 Timestamp role (was R22):** Page `last_edited_time` must be treated as a wake-up signal only, not as a complete conflict oracle.
- **PLAN-R03 No silent LWW pointer (was R25):** Bidirectional surfaces must obey the canonical no-silent-LWW doctrine [[XC-R02]]. Last-writer-wins must not be the default behavior for any bidirectional surface. (Canonical statement lives in the top-level cross-cutting requirements; this is a pointer, not a copy.)
- **PLAN-R04 Disjoint merge (was R26):** Proven disjoint local and remote edits must merge automatically at property/body/schema sub-surface granularity.
- **PLAN-R05 Conflict records (was R27):** Same-surface edits, delete-vs-edit, schema drift affecting edited fields, body truncation, path collisions, and unavailable relations must create durable conflict records.
- **PLAN-R06 Conflict resolution (was R28):** Conflict resolution must append events and commands; conflict rows must not be mutated as hidden state.
- **PLAN-R07 Unsupported guard (was R29):** Unknown, truncated, unsupported, or lossy payloads must block automatic writes to affected surfaces.
- **PLAN-R08 Query absence (was R36):** Absence from a data-source query is never sufficient evidence for deletion.
- **PLAN-R09 Direct classifier (was R37):** Candidate absence must be classified by direct page retrieval as trashed, restored, moved out, moved between tracked sources, inaccessible, or unknown.
- **PLAN-R10 Two-phase local delete (was R38):** Local file deletion may create a pending remote-trash intent only when sidecar state and SQLite row identity prove the target.
- **PLAN-R11 Forget operation (was R39):** Removing local sync records must be a distinct explicit `forget` operation and must not imply a remote delete.
- **PLAN-R12 Restore operation (was R40):** Remote and local restore must be first-class operations that clear tombstones only after observation.
- **PLAN-R13 Permission ambiguity (was R41):** Permission loss, restricted objects, missing write capability, and unknown 404/403 states must fail closed instead of deleting, forgetting, or mutating data.

## Acceptable Tradeoffs

- **PLAN-T01 Conservative writes (was T01):** The system may block writes that are probably safe when it cannot prove they preserve remote and local state.
- **PLAN-T02 Typed unsupported states (was T05):** Unsupported Notion features may be preserved, blocked, or surfaced as conflicts before they become first-class editable local shapes.
