# Glossary: content-address

**Content address** - An identity derived from artifact bytes, usually a cryptographic digest.

**Content descriptor** - A self-describing record containing digest, byte length, media type, and optional codec/schema version.

**CAS** - Content-addressed storage. In this VRS, the store maps digest-derived object paths to bytes.

**Object path** - The deterministic relative path derived from a digest, such as `sha256/ab/cdef...`.

**Store root** - The filesystem or transport root used to locate object paths.

**Resolver** - A component that maps a location-independent artifact URI plus resolver context to verified bytes.

**`cas:` URI** - A location-independent retrieval URI whose path is derived from a content digest.

**Canonical JSON** - A stable JSON byte encoding used when structured values need deterministic hashes.
