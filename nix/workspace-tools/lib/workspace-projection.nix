{ pkgs }:
let
  jq = "${pkgs.jq}/bin/jq";
  rm = "${pkgs.coreutils}/bin/rm";
  dirnameBin = "${pkgs.coreutils}/bin/dirname";
  realpathBin = "${pkgs.coreutils}/bin/realpath";
  find = "${pkgs.findutils}/bin/find";
in
{
  /**
    Project a copied peer package into the topology that owns the install.

    `runtime` keeps runtime-relevant manifest fields so source imports from the
    copied package can still resolve their transitive dependencies through the
    projected root install. `minimal` is the stricter fallback for topologies
    whose lockfile does not model member importers and therefore cannot safely
    validate member dependency metadata.
  */
  shellFns = ''
    find_projection_root() {
      local dir="$1"

      while [ "$dir" != "/" ]; do
        if [ -d "$dir/repos" ] || [ -d "$dir/flakes" ] || [ -f "$dir/pnpm-workspace.yaml" ]; then
          printf '%s\n' "$dir"
          return 0
        fi
        dir="$(${dirnameBin} "$dir")"
      done

      return 1
    }

    rewrite_projected_workspace_deps() {
      local member_dir="$1"
      local manifest="$member_dir/package.json"
      local projection_root

      projection_root="$(find_projection_root "$member_dir")" || return 0

      for section in dependencies optionalDependencies peerDependencies devDependencies; do
        ${jq} -r --arg section "$section" '
          .[$section] // {}
          | to_entries[]
          | select((.value | type) == "string" and (.value | startswith("workspace:")))
          | .key
        ' "$manifest" | while IFS= read -r dep; do
          local target_manifest
          local target_dir
          local rel
          local file_rel

          [ -z "$dep" ] && continue

          target_manifest="$(${find} "$projection_root"             -path '*/node_modules' -prune -o             -name package.json -print | while IFS= read -r candidate; do
              if [ "$candidate" = "$manifest" ]; then
                continue
              fi
              if [ "$(${jq} -r '.name // empty' "$candidate")" = "$dep" ]; then
                printf '%s\n' "$candidate"
                break
              fi
            done)"

          [ -z "$target_manifest" ] && continue

          target_dir="$(${dirnameBin} "$target_manifest")"
          rel="$(${realpathBin} --relative-to="$member_dir" "$target_dir")"
          file_rel="file:$rel"

          ${jq} --arg section "$section" --arg dep "$dep" --arg fileRel "$file_rel" '
            .[$section][$dep] = $fileRel
          ' "$manifest" > "$manifest.tmp"
          mv "$manifest.tmp" "$manifest"
        done
      done
    }

    project_workspace_member() {
      local member_dir="$1"
      local mode="''${2:-runtime}"
      local manifest_filter

      case "$mode" in
        runtime)
          manifest_filter='
            {
              name,
              version,
              private,
              type,
              exports,
              bin,
              main,
              module,
              types,
              browser,
              "react-native": ."react-native",
              sideEffects: .sideEffects,
              files,
              dependencies,
              optionalDependencies,
              peerDependencies,
              peerDependenciesMeta
            }
            | with_entries(select(.value != null))
          '
          ;;
        minimal)
          manifest_filter='
            {
              name,
              version,
              private,
              type,
              exports,
              bin,
              main,
              module,
              types,
              browser,
              "react-native": ."react-native",
              sideEffects: .sideEffects,
              files
            }
            | with_entries(select(.value != null))
          '
          ;;
        *)
          echo "Unknown workspace projection mode: $mode" >&2
          return 1
          ;;
      esac

      if [ -f "$member_dir/package.json" ]; then
        ${jq} "$manifest_filter" "$member_dir/package.json" > "$member_dir/package.json.tmp"
        mv "$member_dir/package.json.tmp" "$member_dir/package.json"

        if [ "$mode" = runtime ]; then
          # Projected runtime members still need their intra-topology workspace edges,
          # but those edges must resolve through the projected root install owner.
          rewrite_projected_workspace_deps "$member_dir"
        fi
      fi

      # The projected root topology is the only install owner, so copied peer
      # packages must not carry nested pnpm state from their original workspace.
      ${rm} -f "$member_dir/pnpm-lock.yaml" "$member_dir/pnpm-workspace.yaml" "$member_dir/.npmrc"
    }
  '';
}
