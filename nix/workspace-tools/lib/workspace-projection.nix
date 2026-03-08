{ pkgs }:
let
  jq = "${pkgs.jq}/bin/jq";
  rm = "${pkgs.coreutils}/bin/rm";
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
              react-native,
              sideEffects,
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
              react-native,
              sideEffects,
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
      fi

      # The projected root topology is the only install owner, so copied peer
      # packages must not carry nested pnpm state from their original workspace.
      ${rm} -f "$member_dir/pnpm-lock.yaml" "$member_dir/pnpm-workspace.yaml" "$member_dir/.npmrc"
    }
  '';
}
