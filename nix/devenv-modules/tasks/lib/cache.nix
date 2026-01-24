# Task cache helpers
#
# Shared caching rules:
# - Cache root: ${config.devenv.root}/.direnv/task-cache
# - Cache files are plain text fingerprints (git SHA, content hashes, etc).
# - Updates must be atomic (temp file + rename) to avoid partial writes.
# - Callers set `cache_value` before using `writeCacheFile`.
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
