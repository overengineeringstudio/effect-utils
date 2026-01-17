builtins.toFile "auto-rebuild-clis.sh" ''
  # Auto-rebuild Nix CLIs when PATH doesn't match expected flake outputs.
  # Args:
  #   1) flake ref (path or flake URL)
  #   2) space-separated build package names (flake outputs)
  #   3) reload command to re-evaluate the env (string evaluated after rebuild)
  #   4) outPaths attr (optional, defaults to cliOutPaths)
  #   5) binary names to check in PATH (optional, defaults to build packages)
  #
  # Optional helper:
  #   prepare_cli_workspace <workspace-root>
  #     Syncs a minimal workspace into .direnv/cli-workspace for dirty builds.
  #     Prints the workspace path to stdout.
  #
  #   auto_rebuild_nix_clis_for_workspace <workspace-root> <reload-cmd> [flake-ref]
  #     Uses NIX_CLI_DIRTY + NIX_CLI_* env vars to pick outputs and rebuild.

  prepare_cli_workspace() {
    local workspace_root="$1"
    local cli_workspace="''${NIX_CLI_DIRTY_WORKSPACE:-$workspace_root/.direnv/cli-workspace}"
    local -a include_args
    local -a include_paths
    local -a package_roots
    local -a package_names
    local -a extra_paths

    if [ -z "$workspace_root" ]; then
      echo "direnv: prepare_cli_workspace requires a workspace root" >&2
      return 1
    fi
    if ! command -v rsync >/dev/null 2>&1; then
      echo "direnv: rsync is required to prepare the CLI workspace" >&2
      return 1
    fi

    mkdir -p "$cli_workspace"

    add_include_path() {
      local path="''${1%/}"
      local prefix=""
      local -a parts

      if [ -z "$path" ]; then
        return 0
      fi

      IFS='/' read -r -a parts <<<"$path"
      for part in "''${parts[@]}"; do
        if [ -n "$part" ]; then
          prefix="''${prefix}''${part}/"
          include_args+=("--include" "/''${prefix}")
        fi
      done

      include_args+=("--include" "/''${path}")
      include_args+=("--include" "/''${path}/***")
    }

    # Env overrides:
    # - NIX_CLI_DIRTY_WORKSPACE: staging dir (defaults to .direnv/cli-workspace).
    # - NIX_CLI_DIRTY_INCLUDE_PATHS: base include paths (space-separated).
    # - NIX_CLI_DIRTY_PACKAGES: package names to include (space-separated).
    # - NIX_CLI_DIRTY_PACKAGE_ROOTS: roots for packages (space-separated).
    # - NIX_CLI_DIRTY_EXTRA_PATHS: extra include paths (space-separated).

    # Default layout matches effect-utils. Override with NIX_CLI_DIRTY_INCLUDE_PATHS
    # for repos that need different inputs.
    if [ -n "''${NIX_CLI_DIRTY_INCLUDE_PATHS:-}" ]; then
      read -r -a include_paths <<<"''${NIX_CLI_DIRTY_INCLUDE_PATHS}"
    else
      include_paths=(
        "flake.nix"
        "flake.lock"
        "nix"
        "scripts"
        "patches"
        "dotdot.json"
        "dotdot.json.genie.ts"
        "tsconfig.all.json"
        "tsconfig.all.json.genie.ts"
      )
    fi
    for path in "''${include_paths[@]}"; do
      add_include_path "''${path}"
    done

    if [ -n "''${NIX_CLI_DIRTY_PACKAGES:-}" ]; then
      read -r -a package_names <<<"''${NIX_CLI_DIRTY_PACKAGES}"
      # Allow "-dirty" package names; strip suffixes for staging paths.
      for index in "''${!package_names[@]}"; do
        package_names[$index]="''${package_names[$index]%-dirty}"
      done
    else
      package_names=("genie" "dotdot" "mono" "utils" "cli-ui")
    fi

    # Package roots let peer repos reuse this helper without editing it.
    if [ -n "''${NIX_CLI_DIRTY_PACKAGE_ROOTS:-}" ]; then
      read -r -a package_roots <<<"''${NIX_CLI_DIRTY_PACKAGE_ROOTS}"
    else
      package_roots=("packages/@overeng")
    fi
    for root in "''${package_roots[@]}"; do
      for package in "''${package_names[@]}"; do
        add_include_path "''${root}/''${package}"
      done
    done

    # Optional extra paths (space-separated) for repo-specific inputs.
    if [ -n "''${NIX_CLI_DIRTY_EXTRA_PATHS:-}" ]; then
      read -r -a extra_paths <<<"''${NIX_CLI_DIRTY_EXTRA_PATHS}"
      for path in "''${extra_paths[@]}"; do
        add_include_path "''${path}"
      done
    fi

    # Sync only the minimal CLI workspace; respect .gitignore to avoid heavy artifacts.
    rsync -a --delete --prune-empty-dirs \
      --filter=':- .gitignore' \
      "''${include_args[@]}" \
      --exclude '*' \
      "$workspace_root/" "$cli_workspace/"

    printf '%s\n' "$cli_workspace"
  }

  prepare_cli_flake() {
    prepare_cli_workspace "$@"
  }

  auto_rebuild_nix_clis() {
    local flake_ref="$1"
    local build_packages="$2"
    local reload_cmd="$3"
    local out_paths_attr="''${4:-cliOutPaths}"
    local binary_names="''${5:-$build_packages}"
    local needs_reload=0

    if [ "''${MONO_AUTO_REBUILD:-1}" = "0" ]; then
      return 0
    fi
    if ! command -v nix >/dev/null 2>&1; then
      return 0
    fi

    local system
    local eval_cores
    system=$(nix config show system)
    eval_cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)

    local -a package_list
    local -a binary_list
    local -a expected_paths
    local package
    local nix_apply
    local expected_paths_json
    read -r -a package_list <<<"$build_packages"
    read -r -a binary_list <<<"$binary_names"
    if [ "''${#package_list[@]}" -ne "''${#binary_list[@]}" ]; then
      echo "direnv: build package list and binary list must match in length" >&2
      return 1
    fi
    nix_apply='x: ['
    for package in "''${binary_list[@]}"; do
      nix_apply+=" x.''${package}"
    done
    nix_apply+=" ]"
    if ! expected_paths_json=$(nix eval --json --no-write-lock-file --apply "$nix_apply" "''${flake_ref}#''${out_paths_attr}.''${system}"); then
      echo "direnv: failed to eval ''${out_paths_attr}" >&2
      return 1
    fi
    expected_paths=()
    if [ "''${expected_paths_json}" != "[]" ]; then
      # Parse JSON array without external tooling. Store paths don't contain quotes,
      # so this split is safe and avoids an extra dependency on jq.
      expected_paths_json="''${expected_paths_json#[}"
      expected_paths_json="''${expected_paths_json%]}"
      expected_paths_json="''${expected_paths_json#\"}"
      expected_paths_json="''${expected_paths_json%\"}"
      IFS='","' read -r -a expected_paths <<<"''${expected_paths_json}"
    fi
    for index in "''${!binary_list[@]}"; do
      package="''${binary_list[$index]}"
      expected="''${expected_paths[$index]}"
      actual=$(command -v "''${package}" 2>/dev/null || true)
      actual=''${actual%/bin/''${package}}
      if [ "''${expected}" != "''${actual}" ]; then
        needs_reload=1
      fi
    done

    if [ "''${needs_reload}" = "1" ]; then
      local -a build_args
      build_args=()
      for package in $build_packages; do
        build_args+=("''${flake_ref}#''${package}")
      done
      echo "direnv: auto rebuilding Nix CLIs (set MONO_AUTO_REBUILD=0 to disable)"
      if nix build \
        --option eval-cores "''${eval_cores}" \
        --option max-jobs "''${eval_cores}" \
        --no-link \
        --no-write-lock-file \
        "''${build_args[@]}"; then
        if [ -n "''${reload_cmd}" ]; then
          echo "direnv: reloading devenv env to pick up rebuilt CLIs"
          # The reload hook is passed as a string so we can call direnv's `use devenv`.
          eval "''${reload_cmd}"
        fi
      fi
    fi
  }

  auto_rebuild_nix_clis_for_workspace() {
    local workspace_root="$1"
    local reload_cmd="$2"
    local flake_ref_override="''${3:-}"
    # Env overrides:
    # - NIX_CLI_PACKAGES: base package list (space-separated, defaults to genie/dotdot/mono).
    # - NIX_CLI_BINARIES: binary names to check in PATH (space-separated).
    # - NIX_CLI_OUT_PATHS_ATTR: clean outPaths attr (defaults to cliOutPaths).
    # - NIX_CLI_DIRTY_OUT_PATHS_ATTR: dirty outPaths attr (defaults to cliOutPathsDirty).
    # - NIX_CLI_DIRTY_PACKAGES: dirty build package list (space-separated).
    # - NIX_CLI_FLAKE: flake ref to build (defaults to ".").
    # - NIX_CLI_WORKSPACE_ROOT: workspace root to stage for dirty builds.
    local packages="''${NIX_CLI_PACKAGES:-genie dotdot mono}"
    local binaries="''${NIX_CLI_BINARIES:-$packages}"
    local clean_out_paths="''${NIX_CLI_OUT_PATHS_ATTR:-cliOutPaths}"
    local dirty_out_paths="''${NIX_CLI_DIRTY_OUT_PATHS_ATTR:-cliOutPathsDirty}"
    local flake_ref="''${NIX_CLI_FLAKE:-.}"
    local workspace_root_override="''${NIX_CLI_WORKSPACE_ROOT:-$workspace_root}"
    local build_packages="$packages"
    local out_paths_attr="$clean_out_paths"
    local -a base_packages
    local -a dirty_packages

    if [ "''${MONO_AUTO_REBUILD:-1}" = "0" ]; then
      return 0
    fi

    if [ "''${NIX_CLI_DIRTY:-0}" = "1" ]; then
      if [ -z "$workspace_root_override" ]; then
        echo "direnv: auto_rebuild_nix_clis_for_workspace requires a workspace root" >&2
        return 1
      fi
      local cli_workspace
      cli_workspace=$(prepare_cli_workspace "$workspace_root_override") || return 1
      flake_ref="path:$cli_workspace"
      out_paths_attr="$dirty_out_paths"
      if [ -n "''${NIX_CLI_DIRTY_PACKAGES:-}" ]; then
        build_packages="''${NIX_CLI_DIRTY_PACKAGES}"
      else
        read -r -a base_packages <<<"$packages"
        dirty_packages=()
        for package in "''${base_packages[@]}"; do
          dirty_packages+=("''${package}-dirty")
        done
        build_packages="''${dirty_packages[*]}"
      fi
    fi

    if [ -n "$flake_ref_override" ]; then
      flake_ref="$flake_ref_override"
    fi

    auto_rebuild_nix_clis "$flake_ref" "$build_packages" "$reload_cmd" "$out_paths_attr" "$binaries"
  }
''
