#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
export BUCK2_RULES_REPO="$repo_root"

render_config() {
  nix eval --raw --impure --expr "
    let
      repo = builtins.toPath (builtins.getEnv \"BUCK2_RULES_REPO\");
      flake = builtins.getFlake (toString repo);
      system = builtins.currentSystem;
      pkgs = import flake.inputs.nixpkgs { inherit system; };
    in (flake.lib.mkConsumerBuckRoot ({
      inherit pkgs;
      rules = flake.packages.\${system}.buck2-rules;
      capabilities = flake.packages.\${system}.buck2-capabilities;
      cellName = \"fixture\";
    } // $1)).buckConfig
  "
}

require_line() {
  local config="$1"
  local line="$2"
  printf '%s\n' "$config" | grep -Fx "$line" >/dev/null
}

forbid_line() {
  local config="$1"
  local line="$2"
  if printf '%s\n' "$config" | grep -Fx "$line" >/dev/null; then
    echo "unexpected consumer root config line: $line" >&2
    exit 1
  fi
}

default_config="$(render_config '{}')"
require_line "$default_config" '  remote_cache_enabled = false'
require_line "$default_config" '  allow_cache_uploads = false'
forbid_line "$default_config" '[buck2_re_client]'
forbid_line "$default_config" '[archive_origin]'

private_config="$(render_config '{
  remoteCacheEnabled = true;
  allowCacheUploads = true;
  actionCacheAddress = "https://actions.example.invalid";
  casAddress = "https://cas.example.invalid";
  cacheInstanceName = "fixture-private";
  cacheTls = true;
  archiveOriginUrlPrefix = "https://archives.example.invalid/cas/";
  archiveOriginTier = "private";
}')"
require_line "$private_config" '  remote_cache_enabled = true'
require_line "$private_config" '  allow_cache_uploads = true'
require_line "$private_config" '[buck2_re_client]'
require_line "$private_config" '  action_cache_address = https://actions.example.invalid'
require_line "$private_config" '  cas_address = https://cas.example.invalid'
require_line "$private_config" '  instance_name = fixture-private'
require_line "$private_config" '  tls = true'
require_line "$private_config" '[archive_origin]'
require_line "$private_config" '  url_prefix = https://archives.example.invalid/cas/'
require_line "$private_config" '  trusted_tier = private'

echo 'buck2 consumer root config passed'
