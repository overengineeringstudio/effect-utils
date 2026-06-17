# Body evidence belongs below the transport client

Status: accepted

Body evidence schemas and fingerprint builders are domain contracts, not HTTP
client internals. The Notion effect client collects API snapshots and maps them
into the evidence model; NotionMD and datasource-sync consume that model without
depending on transport-client ownership of body identity.
