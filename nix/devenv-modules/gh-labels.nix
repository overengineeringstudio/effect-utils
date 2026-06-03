# Reconcile .github/labels.json against live GitHub labels.
#
# Two devenv tasks:
#   - `gh:apply-labels` — upsert, migrate, delete (idempotent mutation)
#   - `gh:check-labels` — same diff with would-* output, exits non-zero on drift
#
# The bash is wrapped in `pkgs.writeShellApplication` so shellcheck runs at
# build time and `gh` / `jq` are pinned via `runtimeInputs` instead of relying
# on the ambient devenv PATH at task-exec time.
#
# Usage in devenv.nix:
#   imports = [
#     (import ./nix/devenv-modules/gh-labels.nix { repo = "owner/name"; })
#   ];
{
  # Target GitHub repository in `owner/name` form. Required so downstream
  # consumers (e.g. schickling/dotfiles) can reuse this module without forking.
  repo,
}:
{
  pkgs,
  ...
}:
let
  apply = pkgs.writeShellApplication {
    name = "gh-apply-labels";
    runtimeInputs = [
      pkgs.gh
      pkgs.jq
    ];
    text = ''
      REPO="${repo}"
      LABELS=$(jq -c '.labels[]' .github/labels.json)
      DEPRECATED=$(jq -r '.deprecated // [] | .[]' .github/labels.json)
      MIGRATIONS=$(jq -c '.legacyMigrations // [] | .[]' .github/labels.json)
      LIVE=$(gh api "repos/$REPO/labels" --paginate)

      # 1. Upsert each desired label (create or patch on color/description drift)
      while IFS= read -r d; do
        name=$(jq -r .name <<<"$d")
        color=$(jq -r .color <<<"$d")
        desc=$(jq -r .description <<<"$d")
        existing=$(jq -c --arg n "$name" '.[] | select(.name == $n)' <<<"$LIVE")
        if [ -z "$existing" ]; then
          gh api "repos/$REPO/labels" --method POST -f name="$name" -f color="$color" -f description="$desc"
        elif [ "$(jq -r .color <<<"$existing")" != "$color" ] || [ "$(jq -r .description <<<"$existing")" != "$desc" ]; then
          gh api "repos/$REPO/labels/$name" --method PATCH -f color="$color" -f description="$desc"
        fi
      done <<<"$LABELS"

      # 2. Migrate issues from legacy -> current
      while IFS= read -r m; do
        [ -z "$m" ] && continue
        from=$(jq -r .from <<<"$m")
        to=$(jq -r .to <<<"$m")
        gh api "repos/$REPO/issues?labels=$from&state=all" --paginate --jq '.[].number' | while read -r n; do
          gh api "repos/$REPO/issues/$n/labels" --method POST -f "labels[]=$to"
          gh api "repos/$REPO/issues/$n/labels/$from" --method DELETE 2>/dev/null || true
        done
      done <<<"$MIGRATIONS"

      # 3. Delete deprecated labels (skip if migration still pending)
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        if jq -e --arg n "$name" 'select(.from == $n)' <<<"$MIGRATIONS" >/dev/null 2>&1; then
          echo "skip delete $name - still has pending migration"
        else
          gh api "repos/$REPO/labels/$name" --method DELETE 2>/dev/null || true
        fi
      done <<<"$DEPRECATED"

      echo "Applied labels.json to $REPO"
    '';
  };

  check = pkgs.writeShellApplication {
    name = "gh-check-labels";
    runtimeInputs = [
      pkgs.gh
      pkgs.jq
    ];
    text = ''
      REPO="${repo}"
      LABELS=$(jq -c '.labels[]' .github/labels.json)
      DEPRECATED=$(jq -r '.deprecated // [] | .[]' .github/labels.json)
      MIGRATIONS=$(jq -c '.legacyMigrations // [] | .[]' .github/labels.json)
      LIVE=$(gh api "repos/$REPO/labels" --paginate)

      drift=0

      # 1. Detect creates / patches against desired labels
      while IFS= read -r d; do
        name=$(jq -r .name <<<"$d")
        color=$(jq -r .color <<<"$d")
        desc=$(jq -r .description <<<"$d")
        existing=$(jq -c --arg n "$name" '.[] | select(.name == $n)' <<<"$LIVE")
        if [ -z "$existing" ]; then
          printf 'would-create %s\n' "$name"
          drift=$((drift + 1))
        elif [ "$(jq -r .color <<<"$existing")" != "$color" ] || [ "$(jq -r .description <<<"$existing")" != "$desc" ]; then
          printf 'would-patch %s\n' "$name"
          drift=$((drift + 1))
        fi
      done <<<"$LABELS"

      # 2. Detect pending migrations (count open+closed issues carrying `from`)
      while IFS= read -r m; do
        [ -z "$m" ] && continue
        from=$(jq -r .from <<<"$m")
        to=$(jq -r .to <<<"$m")
        count=$(gh api "repos/$REPO/issues?labels=$from&state=all" --paginate --jq '.[].number' | wc -l | tr -d ' ')
        if [ "$count" -gt 0 ]; then
          printf 'would-migrate %s -> %s (%d issues)\n' "$from" "$to" "$count"
          drift=$((drift + 1))
        fi
      done <<<"$MIGRATIONS"

      # 3. Detect deletable deprecated labels
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        if jq -e --arg n "$name" 'select(.from == $n)' <<<"$MIGRATIONS" >/dev/null 2>&1; then
          continue
        fi
        if jq -e --arg n "$name" '.[] | select(.name == $n)' <<<"$LIVE" >/dev/null 2>&1; then
          printf 'would-delete %s\n' "$name"
          drift=$((drift + 1))
        fi
      done <<<"$DEPRECATED"

      printf 'Drift: %d action(s) needed\n' "$drift"
      [ "$drift" -eq 0 ]
    '';
  };
in
{
  tasks."gh:apply-labels" = {
    after = [ "genie:run" ];
    exec = "${apply}/bin/gh-apply-labels";
    description = "Apply .github/labels.json to GitHub labels (idempotent)";
  };

  tasks."gh:check-labels" = {
    after = [ "genie:run" ];
    exec = "${check}/bin/gh-check-labels";
    description = "Diff .github/labels.json against live GitHub labels (no apply)";
  };
}
