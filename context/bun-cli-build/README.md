# Bun CLI Build Pattern

Reusable Nix builder for Bun-compiled TypeScript CLIs. Designed to work
inside effect-utils and in external repos that import effect-utils as a
submodule or flake input.

## Builder

- Path: `nix/mk-bun-cli.nix`
- Inputs: `pkgs`, `pkgsUnstable`, `src`
- Versioning: reads `packageJsonPath` for base version, appends `+<gitRev>`
- Injection: defines `__CLI_VERSION__` at build time
- Deps: fixed-output bun deps (`bunDepsHash`)

## CLI Version Pattern

```ts
declare const __CLI_VERSION__: string | undefined

const baseVersion = '0.1.0'
const version =
  typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__.length > 0
    ? __CLI_VERSION__
    : baseVersion
```

## Inside effect-utils

```nix
let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix {
    inherit pkgs pkgsUnstable src;
  };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/cli.ts";
  packageJsonPath = "packages/@overeng/genie/package.json";
  bunDepsHash = "sha256-...";
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
}
```

## Outside effect-utils (submodule or flake input)

Prefer passing `gitRev` from the parent repo so the built binary reflects the
parent’s commit:

```nix
let
  mkBunCli = import "${effect-utils}/nix/mk-bun-cli.nix" {
    inherit pkgs pkgsUnstable;
    src = ./.;
  };
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
in
{
  packages.${system}.my-cli = mkBunCli {
    name = "my-cli";
    entry = "packages/my-cli/src/cli.ts";
    packageJsonPath = "packages/my-cli/package.json";
    bunDepsHash = "sha256-...";
    inherit gitRev;
  };
}
```

## Cross-submodule dependencies (important)

If your CLI or UI build depends on packages that live in a git submodule
outside the current flake source (e.g., `link:` deps), the Nix sandbox cannot
resolve those paths. This is the main source of extra complexity outside
effect-utils.

Recommended pattern:

- Vendor the external package into the fixed-output deps input.
- Rewrite `bun.lock` to use `file:vendor/<name>` instead of `link:...`.
- Strip `catalog:` devDependencies from the vendored package so `bun install`
  does not fail.

Minimal example with comments:

```nix
let
  # Rewrite dependency to a vendored path for sandboxed builds.
  packageJsonForBun = packageJson // {
    dependencies = (packageJson.dependencies or {}) // {
      "@overeng/effect-react" = "file:vendor/effect-react";
    };
  };
  # Replace link: in the lockfile with file:vendor to keep bun.lock usable.
  bunLockForBun = builtins.replaceStrings
    [ "link:../../../../../submodules/effect-utils/packages/@overeng/effect-react" ]
    [ "file:vendor/effect-react" ]
    (builtins.readFile ./bun.lock);
  # Strip catalog-based devDependencies so bun install doesn't fail.
  effectReactPackage = builtins.fromJSON (builtins.readFile "${effectReactSrc}/package.json");
  effectReactPackageForBun = effectReactPackage // { devDependencies = {}; };
  # Provide a minimal vendored package in the fixed-output dependency input.
  depFiles = pkgs.runCommand "dep-files" {} ''
    mkdir -p $out/vendor/effect-react
    cat > $out/package.json <<'EOF'
    ${builtins.toJSON packageJsonForBun}
    EOF
    cat > $out/bun.lock <<'EOF'
    ${bunLockForBun}
    EOF
    cat > $out/vendor/effect-react/package.json <<'EOF'
    ${builtins.toJSON effectReactPackageForBun}
    EOF
    # Only source files needed at build time.
    cp -r ${effectReactSrc}/src $out/vendor/effect-react/src
  '';
in
mkBunCli {
  # ...
  depFiles = depFiles;
}
```

## Notes

- Package-local flakes in effect-utils are not the git root, so `sourceInfo.*`
  may be `none`.
- When in doubt, pass `gitRev` from the calling repo’s flake (`self.sourceInfo`).
