{ pkgs, tools }:
pkgs.runCommand "stage0-cargo-metadata"
  {
    nativeBuildInputs = [
      pkgs.cargo
      pkgs.rustc
    ];
  }
  (
    ''
      mkdir -p "$out"
    ''
    + pkgs.lib.concatStringsSep "\n" (
      pkgs.lib.mapAttrsToList (name: tool: ''
        work="$TMPDIR/${name}"
        mkdir -p "$work" "$TMPDIR/home-${name}"
        cp -R ${tool.src}/rust/. "$work/"
        chmod -R u+w "$work"
        mkdir -p "$work/.cargo"
        printf '[source.crates-io]\nreplace-with = "nix-vendor"\n[source.nix-vendor]\ndirectory = "%s"\n' \
          '${tool.cargoDeps}' > "$work/.cargo/config.toml"
        (cd "$work" && CARGO_HOME="$TMPDIR/home-${name}" cargo metadata \
          --locked --offline --format-version 1 > "$out/${name}.json")
        cmp ${tool.src}/rust/Cargo.lock "$work/Cargo.lock"
      '') tools
    )
  )
