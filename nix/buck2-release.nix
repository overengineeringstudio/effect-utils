# Shared release metadata, including the authoritative supported-platform set.
rec {
  version = "2026-09-01";
  releaseBaseUrl = "https://github.com/facebook/buck2/releases/download/${version}";
  prelude = rec {
    revision = "1f8c24e0b1f85e645011f93a4073b0c6c762d7b1";
    url = "https://github.com/facebook/buck2-prelude/archive/${revision}.tar.gz";
    hash = "sha256-iwXAuHXXfw/FsR0N2CMR0GXHg1I2BHlhZ2orM7z9qas=";
  };
  platforms = {
    x86_64-linux = {
      executionPlatform = "x86_64-linux";
      suffix = "x86_64-unknown-linux-gnu";
      buck2Hash = "sha256-3JRHvS4Thg/BVwAaGAPFGMCFRE3MbGVGDZ0fVRVLMqM=";
      rustProjectHash = "sha256-jNF1qQNhFmy6o0RAXODgjrCwxV8IX3LERUAzFdtuELM=";
      starlarkFmtHash = "sha256-jUQXVSDoS44JDAjcSBXwwwVQfoOIzFwWWoTZuEtKen8=";
    };
    aarch64-linux = {
      executionPlatform = "aarch64-linux";
      suffix = "aarch64-unknown-linux-gnu";
      buck2Hash = "sha256-287nXbAMVX3y27OCxrW+FkPAhrh9kkqrcGCZinptWAE=";
      rustProjectHash = "sha256-Mk5hgW6OhODKHI/urBnXUZSjR2lrIlDDzrZBUgUUsmw=";
      starlarkFmtHash = "sha256-gkqGiT8Qr+jRN3uEtNxZWvdBQw9I/gjs3FMtB2GrFxI=";
    };
    aarch64-darwin = {
      executionPlatform = "aarch64-macos";
      suffix = "aarch64-apple-darwin";
      buck2Hash = "sha256-CWLKffGnawcHxro/8SFtMUMdSTrjfvAB6ptC9KdBCck=";
      rustProjectHash = "sha256-t0D+YOjlFSQR+eKaQ97Zb4jbor0IkthqZgPtpLymG4E=";
      starlarkFmtHash = "sha256-CIJ6XFRuW2AKZJYjSNOu5fGzJfkRnkTsUaWfCrmbBBY=";
    };
  };
}
