# Converge local surfaces before remote planning

Status: accepted

Data files and `pages/v1/**/*.nmd` are both user surfaces, but they must not become
competing local authorities. Before sync plans remote writes, it must decode
both surfaces, map facts to stable page/property/body/lifecycle identities,
coalesce identical desired states, and raise local conflicts for divergent
desired states.

Local conflicts block remote mutation. Remote planning starts only after there
is one unambiguous local desired state for each affected surface.

## Considered Options

| Option                                    | Result          | Reason                                                                                            |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| Partition writable facts by surface       | Rejected        | Too restrictive; Markdown property edits would stop composing with standalone NotionMD.           |
| Let one surface win locally               | Rejected        | Creates hidden last-writer-wins and makes user consequences depend on scan order.                 |
| Workspace chooses one active edit surface | Rejected for v1 | Adds another mode axis and weakens the simple default.                                            |
| Mandatory local convergence               | Recommended     | Keeps both surfaces real while preserving one unambiguous local desired state before remote sync. |
