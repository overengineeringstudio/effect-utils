# Datasource Control Plane Intuition

*For: datasource-sync maintainers · Assumes: datasource Markdown workspace
realization · Covers: hidden workspace state and proof ownership*

This child node isolates the hidden datasource workspace mechanism: replica
state, outbox, conflicts, leases, watermarks, and settlement evidence.

Users do not edit this control plane directly. It exists so public SQL and page
surfaces can remain small while writes still fail closed.
