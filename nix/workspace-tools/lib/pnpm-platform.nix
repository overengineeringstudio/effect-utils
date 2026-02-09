# Shared pnpm platform normalization for deterministic cross-platform FODs.
#
# Ensures pnpm fetches binaries for all supported platforms so the fixed-output
# derivation hash is stable across linux-x64, darwin-arm64, etc.
#
# Usage:
#   let pnpmPlatform = import ./pnpm-platform.nix;
#   in ''
#     ${pnpmPlatform.setupScript}
#     pnpm install --frozen-lockfile
#   ''
{
  supportedArchitecturesJson = ''{"os":["linux","darwin"],"cpu":["x64","arm64"]}'';

  # Shell script snippet that configures pnpm supportedArchitectures and verifies it.
  # Include this before pnpm install/fetch in both FOD and build phases.
  setupScript = ''
    pnpm config set supportedArchitectures '{"os":["linux","darwin"],"cpu":["x64","arm64"]}'
    sa="$(pnpm config get supportedArchitectures)"
    if ! printf '%s' "$sa" | grep -q 'linux' ||
       ! printf '%s' "$sa" | grep -q 'darwin' ||
       ! printf '%s' "$sa" | grep -q 'x64' ||
       ! printf '%s' "$sa" | grep -q 'arm64'; then
      echo "error: pnpm supportedArchitectures not set as expected"
      echo "  got: $sa"
      exit 1
    fi
  '';
}
