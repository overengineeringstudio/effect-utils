# Beads (bd) — pre-built binary package from GitHub releases.
# v0.57+ self-manages dolt sql-server per project (deterministic port from FNV hash of BEADS_DIR).
{
  pkgs,
  beadsPrimaryRef ? "main",
}:
let
  version = "0.59.0";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "0bvha0rz7qwd674s4m33f73awmx3jzmlxny3z182qcdn796mqffl";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "17xm93db6rk537djaznsw68jy5cpnzrmdm9bpzb7vfvidn3pprrv";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "0y2pp15g75dmij14as1vk5zr4qg1364h28xbqwzd8ar267w1bylf";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "0ivsr00zvb2gqiyn69rhzi65jd42vvfr5dcjkxk3ny3m68s0fpmn";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformInfo = sources.${system} or (throw "Unsupported system: ${system}");

in
pkgs.stdenv.mkDerivation {
  pname = "beads";
  inherit version;

  dontBuild = true;
  dontStrip = true;

  src = pkgs.fetchurl {
    inherit (platformInfo) url sha256;
  };

  nativeBuildInputs = [
    pkgs.bash
    pkgs.gnutar
    pkgs.installShellFiles
    pkgs.makeWrapper
  ]
  ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.patchelf ];

  unpackPhase = ''
    mkdir -p source
    tar -xzf "$src" -C source
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp source/bd $out/bin/bd-real
    chmod +x $out/bin/bd-real

    # Patch the ELF interpreter before running the binary for completion generation.
    # autoPatchelfHook can't be used here because it runs too late (after installPhase).
    ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
      patchelf --set-interpreter "${pkgs.stdenv.cc.bintools.dynamicLinker}" $out/bin/bd-real
    ''}

    $out/bin/bd-real --help >/dev/null

    installShellCompletion --cmd bd \
      --fish <($out/bin/bd-real completion fish) \
      --bash <($out/bin/bd-real completion bash) \
      --zsh <($out/bin/bd-real completion zsh)

    wrapProgram $out/bin/bd-real --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.dolt ]}

    cat > $out/bin/bd <<'EOF'
    #!${pkgs.bash}/bin/bash
    set -euo pipefail

    realpath_bin="${pkgs.coreutils}/bin/realpath"
    bd_real="${placeholder "out"}/bin/bd-real"
    beads_primary_ref="''${BEADS_PRIMARY_REF:-${beadsPrimaryRef}}"

    has_explicit_db=false
    for arg in "$@"; do
      case "$arg" in
        --db|--db=*)
          has_explicit_db=true
          ;;
      esac
    done

    # TODO: Drop this detached-worktree normalization once beads#2439 is merged
    # and released. Upstream beads should then resolve refs/commits/*/.beads to a
    # stable same-commit branch worktree on its own.
    resolve_beads_dir() {
      local beads_dir="$1"
      local resolved_dir
      local repo_root
      local branch_dir

      resolved_dir="$("$realpath_bin" "$beads_dir")"

      case "$resolved_dir" in
        */refs/commits/*/.beads)
          repo_root="''${resolved_dir%%/refs/commits/*}"
          branch_dir="''${repo_root}/refs/heads/''${beads_primary_ref}/.beads"
          if [ -d "$branch_dir" ]; then
            resolved_dir="$branch_dir"
          fi
          ;;
      esac

      printf '%s\n' "$resolved_dir"
    }

    should_pin_db() {
      local metadata_file="$1/metadata.json"

      [ -f "$metadata_file" ] || return 1

      grep -Eq '"(backend|database)"[[:space:]]*:[[:space:]]*"dolt"' "$metadata_file" \
        || grep -Eq '"dolt_database"[[:space:]]*:' "$metadata_file"
    }

    if [ -n "''${BEADS_DIR:-}" ] && [ -d "$BEADS_DIR" ]; then
      export BEADS_DIR="$(resolve_beads_dir "$BEADS_DIR")"

      if [ -d "''${BEADS_DIR%/.beads}" ]; then
        cd "''${BEADS_DIR%/.beads}"
      fi

      # TODO: Re-check this explicit --db pin after beads#2439 is merged. The
      # upstream PR fixes path identity, but external-store server-mode
      # resolution still needs validation before this wrapper can collapse to a
      # plain bd passthrough.
      if [ "''${has_explicit_db}" = false ] && [ -d "$BEADS_DIR/dolt" ] && should_pin_db "$BEADS_DIR"; then
        exec "$bd_real" --db "$BEADS_DIR/dolt" "$@"
      fi
    fi

    exec "$bd_real" "$@"
    EOF

    chmod +x $out/bin/bd
    ln -s $out/bin/bd $out/bin/beads

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "beads (bd) - An issue tracker for AI-supervised coding workflows";
    homepage = "https://github.com/steveyegge/beads";
    license = licenses.mit;
    mainProgram = "bd";
  };
}
