# Nix derivation that builds notion CLI binary.
# Uses bun build --compile for native platform.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  nodejs = pkgs.nodejs_24 or pkgs.nodejs;
  datasourceSyncBuildStamp = builtins.toJSON {
    type = "nix";
    version = "0.1.0";
    rev = gitRev;
    inherit commitTs dirty;
  };
  unwrapped = mkPnpmCli {
    name = "notion-cli-unwrapped";
    entry = "packages/@overeng/notion-cli/src/cli.ts";
    binaryName = "notion";
    packageDir = "packages/@overeng/notion-cli";
    workspaceRoot = src;
    smokeTestArgs = [
      "md"
      "--help"
    ];
    installRuntimeWorkspace = true;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-1wPReRAcDJFYcivSKUiE4YKDcGWSADTpfbzZjILAx1w=";
      };
    };
    nativeNodePackages = opentuiCoreNative.packages;
    inherit gitRev commitTs dirty;
  };
  notionDbRuntime = pkgs.writeShellScriptBin "notion-db-runtime" ''
    export CLI_BUILD_STAMP=${pkgs.lib.escapeShellArg datasourceSyncBuildStamp}
    exec ${nodejs}/bin/node ${unwrapped}/libexec/workspace/packages/@overeng/notion-datasource-sync/src/cli/main.ts "$@"
  '';
in
pkgs.runCommand "notion-cli"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "notion";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/notion $out/bin/notion \
      --run 'if [ "$#" -gt 1 ] && [ "$1" = db ]; then case "$2" in init|pull|push|sync|track|export|status|conflicts|forget|restore|doctor) shift; exec ${notionDbRuntime}/bin/notion-db-runtime "$@";; esac; fi'

    db_output="$($out/bin/notion db sync --help 2>&1 || true)"
    if ! printf '%s\n' "$db_output" | grep -q 'Reconcile an established workspace'; then
      printf '%s\n' "$db_output" >&2
      echo "notion db sync smoke test failed" >&2
      exit 1
    fi

    # `track` must also route to the Node runtime (needs node:sqlite). A missing
    # route falls through to the Bun-backed wrapper, which fails closed. Grep for
    # a phrase unique to the Node entrypoint's help block ("Packaged Node-backed
    # entrypoint from Nix/devenv" — see renderCliHelpText); the Bun @effect/cli
    # help does not emit it, so this specifically proves `track` is routed.
    track_output="$($out/bin/notion db track --help 2>&1 || true)"
    if ! printf '%s\n' "$track_output" | grep -q 'Packaged Node-backed entrypoint from Nix/devenv'; then
      printf '%s\n' "$track_output" >&2
      echo "notion db track smoke test failed (track not routed to node runtime?)" >&2
      exit 1
    fi

    # Real sync-path regression (PR #898): a `--help` route check cannot catch
    # the actual defect it guards against. A progress-bearing verb (track) runs
    # through `runWithCliSyncProgress`, which dynamically imports the `.tsx`
    # `@overeng/tui-react` TUI. Under packaged Node that import REJECTS (JSX is
    # not stripped) and surfaces as an Effect *defect*; the top-level handler is
    # `Effect.tapError` (failures only), so without the `catchAllDefect` fallback
    # the command dies BEFORE emitting any structured output. `track` is the
    # cheapest verb that clears argument+context parsing on an empty workspace
    # and thus reaches the progress wrapper (`sync` fails earlier as
    # WorkspaceNotTracked, never reaching it). The build sandbox has no network,
    # so the establish then fails FAST (auth/connection errors are non-retryable)
    # with a structured `CliErrorEnvelope` — whose presence proves the TUI import
    # failed soft and real command dispatch was reached. Deleting the
    # `catchAllDefect` line in runWithCliSyncProgress makes this RED (raw defect,
    # no envelope); dropping `track` from the wrapper routing makes it RED via the
    # Bun-runtime guard check below.
    track_run_dir="$(mktemp -d)"
    track_run_output="$(NOTION_API_TOKEN=secret_smoke_invalid_000000000000000000000000 \
      timeout 90 $out/bin/notion db track 11111111-1111-4111-8111-111111111111 "$track_run_dir" --mode local 2>&1 || true)"
    if ! printf '%s\n' "$track_run_output" | grep -qE '"_tag": "Cli(Error|Result)Envelope"'; then
      printf '%s\n' "$track_run_output" >&2
      echo "notion db track sync-progress smoke failed: no structured envelope — the .tsx TUI import defect was not caught (runWithCliSyncProgress catchAllDefect regressed?)" >&2
      exit 1
    fi
    if printf '%s\n' "$track_run_output" | grep -q 'require the packaged Nix/devenv Node-backed runtime'; then
      printf '%s\n' "$track_run_output" >&2
      echo "notion db track fell through to the Bun-runtime guard (not routed to the Node runtime)" >&2
      exit 1
    fi
  ''
