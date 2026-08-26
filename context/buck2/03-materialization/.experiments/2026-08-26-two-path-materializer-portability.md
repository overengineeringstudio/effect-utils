# Two-Path Materializer Portability

## Question

Does real pnpm dependency materialization produce identical relocatable output
when only the checkout, stage, output, and store absolute paths differ?

## Method

The exact committed source at `015c0c00e` was exported twice into distinct
checkout paths of different lengths (`/tmp/materializer-path-a` and
`/tmp/materializer-path-with-different-length-b`). Each checkout received a
separate hardlink copy of the same warm pnpm store. Before either build, a
canonical store digest proved equal inputs: SHA-256
`3441898574f4f537375cf1cdc166e3c9681dda9f4f13d2073999722c55368e99`
for 259 directories, 36,069 files, 1 symlink, and 850,738,371 file bytes in
each copy.

Each checkout then independently ran:

```console
buck2 build //packages/@overeng/tui-core:node_modules \
  --show-output --local-only --no-remote-cache
```

Both builds executed the materialization action locally. The output digest was
computed by walking sorted relative paths without following symlinks and
feeding SHA-256 records with these exact forms:

```text
D NUL relative-path NUL
F NUL relative-path NUL decimal-byte-length NUL file-bytes
L NUL relative-path NUL readlink-bytes NUL
```

A second pass compared the per-entry type, relative path, file-content hash,
and symlink target. It also scanned every file and symlink target for its own
checkout and store absolute prefixes, and required every symlink target to be
relative with both lexical and fully resolved destinations inside the output.

## Result

Both real materializations succeeded and produced the same canonical output
digest:

```text
88625db383ba0277b805cd4332bd9b4a478a838bfb7e0f57ce47f10143494759
```

Each tree contained 921 directories, 4,993 files, 167 symlinks, and 269,474,997
file bytes. The exhaustive per-entry comparison found zero differing entries;
the ordered symlink records were identical. Both absolute-prefix scans found
zero residues, both containment scans found zero unsafe symlinks, and the
materialized `.modules.yaml` contained neither `storeDir` nor `prunedAt`.

Pnpm did mutate each otherwise identical input store after the build by adding
one checkout-derived bookkeeping link under `v11/projects/`. The two stores
therefore differed after execution by two directory entries: each contained
its own project-hash name and lacked the other's. Both link payloads were the
same internal-relative path to the transient deploy directory. No package file
byte changed, and this mutable store bookkeeping did not enter either
materialized output.

## Conclusion

For the admitted Linux x86-64 `tui-core` tuple, worktree, stage, output, and
store path changes do not affect the final `node_modules` path/content/symlink
bytes. The prior categorical explanation that pnpm virtual-store absolute paths
make these trees non-portable is falsified for this tuple. The experiment does
not prove cross-platform semantic equivalence; it proves path relocation with
identical revision and store content on one admitted platform.

The pnpm store's path-derived `v11/projects/` side effect is a separate local
store-lifecycle concern. It is not evidence of output non-portability, but store
maintenance must not treat that bookkeeping namespace as immutable content.

## VRS Impact

- **DEPS-R02:** The real tuple now has direct byte-level evidence for a
  deterministic relocatable output, including post-relocation and
  package-assembly symlink containment.
- **DEPS-T01 and decision 0015:** Their factual premise that materialized trees
  embed absolute virtual-store paths and are therefore non-portable should be
  amended. This evidence supports reconsidering materialization cache upload,
  but this change deliberately leaves `allow_cache_upload` untouched pending
  confirmation of the accepted-decision amendment and cache economics.
- **DEPS-R03 conflict:** A symlink to a live workspace source necessarily
  resolves outside the relocatable output and is correctly rejected. The
  package-tree API can create only explicit relative links to declared files
  copied inside the tree; that contained projection is not live-source
  behavior. The editor realization needs a boundary outside the cacheable tree
  to satisfy DEPS-R03 without weakening DEPS-R02.


## Intent Impact

[VRS Impact](#vrs-impact) records the normative consequences; VRS is this
repository's name for the durable Intent artifact layer.
