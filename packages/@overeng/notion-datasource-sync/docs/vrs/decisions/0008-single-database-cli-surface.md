# Single database CLI surface

Status: accepted

The user-facing CLI surface for data-source sync is `notion db ...`. We remove
the top-level `notion sqlite` namespace, do not introduce a nested
`notion db replica` namespace, and remove the standalone
`notion-datasource-sync` public binary.

The term Replica remains the domain term for the local `<database-id>.sqlite`
artifact, but it is not a command namespace. This keeps the CLI focused on the
database/data-source workflow while preserving SQLite and replica terminology
for specs, implementation, and diagnostics.
