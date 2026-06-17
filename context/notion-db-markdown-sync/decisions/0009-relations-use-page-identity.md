# Relation values use canonical page identity

Status: accepted

Relation properties should be represented by target page identity plus owning
tracked data source, not by local filesystem paths or linked-view paths. Local
paths and titles may be rendered as read-only hints for humans, but they are not
the authoritative value.

## Consequences

Page renames and moves do not rewrite relation identity. Linked views cannot
become relation targets. Adding or editing relation targets requires known,
accessible target page identities under tracked sources. Lookup flows for
untracked targets are outside the v1 surface.
