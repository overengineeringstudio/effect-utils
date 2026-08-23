# Ontology — @overeng/notion-react

## Language

- **Owned region:** The portion of a Notion page this library reconciles from
  JSX. Human edits inside it may be overwritten (A04, T01).
  _Avoid:_ "managed area", "sync scope".
- **Instance tree:** The in-memory tree the react-reconciler host-config
  builds during a render pass. Internal; never exposed.
- **CandidateTree / CandidateNode:** The normalized, hash-annotated
  projection of one render pass — projected Notion-shaped props per block,
  keyed children. The single representation every downstream consumer
  (diff, cache snapshot, Markdown projector) reads.
- **CacheTree:** The persisted counterpart of a CandidateTree (`NotionCache`
  backends), carrying resolved Notion block ids and schema version.
- **Pending inline resolution:** A temporary CacheTree state for a newly
  created page whose server-minted page id is durable while block ids created
  inline with that page still require observation and adoption. It preserves
  create-time identity evidence; it is not a second candidate tree.
- **blockKey:** Author-supplied identity hint for stable sibling matching
  across renders. Renderer-level only: never projected into Notion payloads
  and never emitted into Markdown bodies.
- **Sync:** The production path — CandidateTree vs CacheTree diff → op plan →
  Notion API mutations. Mutating by definition.
- **Projection (Markdown projection):** The read-only serialization of a
  CandidateTree to a Notion-enhanced-Markdown **body** for human review.
  Never mutates Notion, never reads or writes cache. Distinct from Sync and
  from the web preview.
  _Avoid:_ "export" (implies completeness), "render to HTML".
- **Body:** The Markdown string a projection returns. A review artifact —
  not a canonical round-trip representation of Notion content.
- **Diagnostic:** Typed, structured notice that a construct could not be
  represented losslessly in the body (`unsupported-block`,
  `media-without-url`, `color-dropped`, `flattened`). Emitted alongside the
  body; never thrown, never logged to a side channel.
  _Avoid:_ "warning" (implies console noise).
- **Dialect (enhanced-Markdown dialect):** The concrete Markdown spellings
  this workspace treats as Notion-enhanced Markdown — defined de facto by
  the pull-side renderer/canonicalizer in `@overeng/notion-effect-client`.
  The projection aligns with it where sound but owns its own spelling table
  (T10).
- **Envelope (.nmd):** The strict frontmatter + body file format owned by
  `@overeng/notion-md`. The projection produces bodies that compose with it;
  it knows nothing about envelopes.

## Structure

```
JSX (authored components)
  └─ Instance tree ──► CandidateTree ─┬─ diff vs CacheTree ──► ops ──► Notion   (Sync)
                                      └─ Markdown projector ──► Body (+ Diagnostics)
                                                                        │
                                              Envelope (.nmd, notion-md) ◄─ composition
```

Leitwort: **project** always means the read-only Markdown path; **sync**
always means the mutating Notion path. A body never implies sync state, and
diagnostics never imply errors — they are fidelity facts.
