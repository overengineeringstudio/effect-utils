# Cache Contract Ontology

## Language

- **Cache endpoint:** A protocol-addressable service accepting or supplying rebuildable
  bytes or action results; its URI is not an authorization credential.
- **Producer descriptor:** A credential-free declaration of one producer-owned
  endpoint's protocol, stable name, visibility and verification metadata.
- **Composed registry:** The validated set of producer descriptors imported by a
  consumer, without a second hand-maintained endpoint list.
- **Trust tier:** A public/private artifact confidentiality boundary, independent
  of protocol kind and writer authorization.
- **Action-cache namespace:** The repo-scoped action lookup domain created by
  server-side key instance mangling; it does not isolate CAS bytes.

## Structure

Producer descriptor -> partOf composed registry.
Cache endpoint -> related trust tier. Protocol kind and trust tier are independent facets.
