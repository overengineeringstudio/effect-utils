# Budget the recursive directory inputs that devenv re-hashes when validating
# its eval cache. The checker reports each cached attribute separately because
# the same root can have a different cost and owner in each attribute.
{
  budget ? 50000,
  wireInto ? [
    "check:quick"
    "check:all"
  ],
}:
{
  lib,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  checker = pkgs.writeShellApplication {
    name = "devenv-eval-input-budget";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.sqlite
    ];
    text = builtins.readFile ./devenv-eval-input-budget.sh;
  };
in
{
  tasks = lib.mkMerge [
    {
      "check:devenv-eval-inputs" = {
        description = "Fail when a cached devenv attribute exceeds ${toString budget} recursive input files";
        exec = trace.exec "check:devenv-eval-inputs" ''
          set -euo pipefail

          checker=${lib.escapeShellArg (lib.getExe checker)}
          control=$(mktemp -d)
          trap 'rm -rf "$control"' EXIT

          mkdir -p "$control/fixture/nested" "$control/orphan"
          : > "$control/fixture/a"
          : > "$control/fixture/b"
          : > "$control/fixture/nested/c"
          for i in $(seq 1 20); do : > "$control/orphan/f$i"; done

          ${pkgs.sqlite}/bin/sqlite3 "$control/fixture.db" "
            create table file_input (
              id integer primary key,
              path blob not null unique,
              is_directory boolean not null,
              recursive boolean not null default 0
            );
            create table cached_eval (
              id integer primary key,
              attr_name text not null
            );
            create table eval_input_path (
              id integer primary key,
              cached_eval_id integer not null,
              file_input_id integer not null,
              unique(cached_eval_id, file_input_id)
            );
            insert into file_input (id, path, is_directory, recursive)
              values (1, '$control/fixture', 1, 1), (2, '$control/orphan', 1, 1);
            insert into cached_eval (id, attr_name) values (1, 'shell');
            insert into eval_input_path (cached_eval_id, file_input_id) values (1, 1);
          "

          if "$checker" --db "$control/fixture.db" --budget 2 > "$control/over.log" 2>&1; then
            echo "control failed: shell has 3 recursive files against a budget of 2 but passed" >&2
            cat "$control/over.log" >&2
            exit 1
          fi
          grep -q 'shell: 3 files' "$control/over.log" || {
            echo "control failed: over-budget output did not name the shell attribute" >&2
            cat "$control/over.log" >&2
            exit 1
          }
          "$checker" --db "$control/fixture.db" --budget 3 > "$control/under.log" 2>&1 || {
            echo "control failed: shell has 3 recursive files against a budget of 3 but failed" >&2
            cat "$control/under.log" >&2
            exit 1
          }

          "$checker" \
            --db "''${DEVENV_ROOT:?DEVENV_ROOT is unset}/.devenv/nix-eval-cache.db" \
            --budget ${toString budget}
        '';
      };
    }
    (lib.genAttrs wireInto (_: {
      after = lib.mkAfter [ "check:devenv-eval-inputs" ];
    }))
  ];
}
