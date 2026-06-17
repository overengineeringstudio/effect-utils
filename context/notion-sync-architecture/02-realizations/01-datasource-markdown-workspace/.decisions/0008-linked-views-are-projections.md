# Track data sources; model linked views as projections

Status: accepted

The durable ownership unit is the canonical Notion data source, not a linked
database view. Each tracked data source owns one user-facing data file and one
page-file directory. Linked views are read-only presentation/query contexts over
an already tracked `data_source_id`; they must not create additional editable
page materializations or writable SQL files.

## Consequences

Materializing each linked view as editable pages creates multiple local owners
for the same Notion page and makes duplicate linked view names collide. Relation
values must point to canonical source/page identity, not to a linked-view path.
Linked views may appear in status/query/projection UX and may generate explicit
read-only `views/` projections only when requested, but they do not own schema,
pages, deletion, remote writes, or absence evidence. By default, linked views
produce no visible files.
