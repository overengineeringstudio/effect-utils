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
  # Uses .npmrc INI syntax directly — more reliable than `pnpm config set` with JSON,
  # which can silently drop cpu[] values on some pnpm versions/environments.
  setupScript = ''
    cat >> $HOME/.npmrc << 'NPMRC'
supportedArchitectures[os][]=linux
supportedArchitectures[os][]=darwin
supportedArchitectures[cpu][]=x64
supportedArchitectures[cpu][]=arm64
NPMRC
    if ! grep -q 'supportedArchitectures\[cpu\]\[\]=x64' "$HOME/.npmrc" ||
       ! grep -q 'supportedArchitectures\[cpu\]\[\]=arm64' "$HOME/.npmrc"; then
      echo "error: pnpm supportedArchitectures not written to .npmrc"
      cat "$HOME/.npmrc"
      exit 1
    fi
  '';
}
