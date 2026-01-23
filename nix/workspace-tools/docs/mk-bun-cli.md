# mk-bun-cli Patterns

These patterns live in `nix/workspace-tools/lib/mk-bun-cli.nix` and are needed
to keep builds pure, fast, and reliable while supporting local changes. In a
megarepo, prefer building from the local workspace path; `dirty` mode remains
available for edge cases but is not the default.

- **Clean, minimal source staging**: `cleanSourceWith` filters out heavy or
  ephemeral paths (node_modules, result, caches). This keeps the source input
  stable and reduces rebuild churn.

```nix
workspaceSrc = lib.cleanSourceWith {
  src = workspaceRootPath;
  filter = sourceFilter workspaceRootPath;
};
```

- **Workspace copy for writable builds**: the derivation stages a writable copy
  of the workspace (tar pipe) so Bun and tsc can write caches without polluting
  source inputs. This also keeps sandbox writes confined.

```sh
workspace="$PWD/workspace"
mkdir -p "$workspace"
(cd "${workspaceSrc}" && tar -cf - .) | (cd "$workspace" && tar -xf -)
chmod -R u+w "$workspace"
```

- **Fixed-output bunDeps snapshot**: bun installs run inside a fixed-output
  derivation keyed by `bunDepsHash` to make dependency resolution deterministic
  and cacheable across builds.

```nix
outputHashMode = "recursive";
outputHashAlgo = "sha256";
outputHash = bunDepsHash;
```

- **Local file dependency handling**: local dependencies (file: / relative) are
  detected from package.json and installed within bunDeps; their node_modules
  are copied into the bunDeps output and then linked into the build workspace.
  This preserves purity while still allowing local package links.

```nix
isLocal = value: lib.hasPrefix "./" value || lib.hasPrefix "../" value || lib.hasPrefix "file:" value;
```

```sh
ln -s "$dep_source" "$package_path/node_modules/$dep_name"
```

- **Bun install failure hints**: bun install is wrapped to emit a clear error
  when bun.lock drifts from the frozen bunDepsHash, with a direct command to
  refresh the hash.

```sh
if grep -q "lockfile had changes" "$bun_log"; then
  echo "mk-bun-cli: bun.lock changed while bunDepsHash is frozen" >&2
fi
echo "mk-bun-cli: bunDepsHash may be stale; update it (mono nix hash --package ${name})" >&2
```

- **Fast dirty dependency resolution**: dirty builds avoid symlinking the full
  node_modules tree (which gets slow at scale). Instead, local deps are linked
  into the workspace and NODE_PATH points at bunDeps for everything else.

```sh
if ${lib.boolToString dirty}; then
  mkdir -p "$package_path/node_modules"
  export NODE_PATH="$package_path/node_modules:${bunDeps}/node_modules"
else
  ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
fi
```

- **Version injection + smoke test**: the entry file is patched with the build
  version, and a smoke test runs the CLI to validate output inside the build.

```sh
substituteInPlace "$workspace/${entry}" \
  --replace-fail "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"
```

```sh
(cd "$smoke_test_cwd" && "$build_output" ${smokeTestArgsChecked})
```

- **Skip typecheck in dirty mode**: dirty builds skip tsc to avoid TS6305 when
  references are missing, while still enforcing typecheck in clean builds.

```nix
typecheckEnabled = typecheck && !dirty;
```
