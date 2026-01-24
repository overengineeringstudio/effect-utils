# Task cache helpers
#
# Shared caching rules:
# - Cache root: ${config.devenv.root}/.direnv/task-cache
# - Cache files are plain text fingerprints (git SHA, content hashes, etc).
# - Updates must be atomic (temp file + rename) to avoid partial writes.
# - Callers set `cache_value` before using `writeCacheFile`.
#
# Why we add our own fingerprints:
# - We still rely on devenv's `status` mechanism to decide whether a task runs.
# - We provide explicit, deterministic inputs so `status` is stable across shells.
# - This avoids mtime churn or accidental invalidation while keeping tasks fast.
# - Cache files stay local and disposable; correctness never depends on them.
{ config }:
let
  cacheRoot = "${config.devenv.root}/.direnv/task-cache";
  mkCachePath = subPath: "${cacheRoot}/${subPath}";
  writeCacheFile = pathExpr: ''
    tmp_file="$(mktemp)"
    printf "%s" "$cache_value" > "$tmp_file"
    if [ -f ${pathExpr} ] && cmp -s "$tmp_file" ${pathExpr}; then
      rm "$tmp_file"
    else
      mv "$tmp_file" ${pathExpr}
    fi
  '';
in
{
  inherit cacheRoot mkCachePath writeCacheFile;
}
