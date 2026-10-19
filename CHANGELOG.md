# Changelog

## [Unreleased]

### Fixed

- Derive `macos-app-ctl` signing-key IDs from the certificate's public key so an `[apple:]` partition list does not cause `CSSMERR_CSP_OPERATION_AUTH_DENIED` during signing checks. Existing public-key SHA-256 IDs and ACL sidecar records remain unchanged.
