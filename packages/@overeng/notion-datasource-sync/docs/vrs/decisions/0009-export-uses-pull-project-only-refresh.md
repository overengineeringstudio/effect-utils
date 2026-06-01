# Export uses pull/project-only refresh

Status: accepted

`notion db export` may call Notion and create or refresh the local replica when
the user provides `--from-notion`, but export refresh is not a full sync. It
uses a pull/project-only orchestration: establish or validate the binding,
observe remote data, update the replica projections, then export.

Export must never execute outbox commands or mutate Notion. Existing local row
changes remain local desired state; export may report dirty/pending state in
metadata, but it must not push those changes as a side effect of producing an
export file.
