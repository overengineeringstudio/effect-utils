# Nix wrapper for ptym (https://github.com/myobie/pty).
#
# Persistent terminal sessions with detach/attach support. Uses node-pty
# (native N-API addon with prebuilds), so we need Node.js — not Bun.
#
# =============================================================================
# Updating to a new version
# =============================================================================
#
# 1. Get the latest commit SHA:
#    gh api repos/myobie/pty/commits --jq '.[0].sha'
#
# 2. Update `rev` below to the new commit SHA
#
# 3. Set `hash` to an empty string and rebuild — Nix will report the correct hash
#
# 4. Do the same for `npmDepsHash`
#
# 5. Reload devenv and verify:
#    direnv reload
#    pty --help
#
# =============================================================================
{ pkgs }:
let
  version = "0.1.0";
  rev = "c73ce0ced799a5d6991ae093707bd2896db1ba64";
  fishCompletions = ./pty-completions.fish;
in
pkgs.buildNpmPackage {
  pname = "pty";
  inherit version;

  src = pkgs.fetchFromGitHub {
    owner = "myobie";
    repo = "pty";
    inherit rev;
    hash = "sha256-SW4fsMpR6XXvVn3Ih8ikylFvHDsB/pqUTCN8aQ3dJrY=";
  };

  # Computed from package-lock.json — rebuild with empty string to update
  npmDepsHash = "sha256-xCWanXIKz2oqsii5kEK4RWhVROOkTPqitB2zRwbJObs=";

  # No build step needed — the CLI runs TypeScript via tsx at runtime
  dontBuild = true;

  # node-pty ships prebuilds; the postinstall script just chmod's spawn-helper
  # which buildNpmPackage handles fine.

  installPhase = ''
    runHook preInstall

    # Preserve the full source + node_modules tree
    mkdir -p $out/lib/pty
    cp -r . $out/lib/pty

    # Create wrapper that invokes the CLI via Node.js
    mkdir -p $out/bin
    ln -s $out/lib/pty/bin/pty $out/bin/pty
    chmod +x $out/bin/pty

    # Patch shebang to use the Nix-provided Node.js
    substituteInPlace $out/bin/pty \
      --replace-fail "#!/usr/bin/env node" "#!${pkgs.nodejs}/bin/node"

    # Install shell completions (fish is maintained locally since upstream only ships bash/zsh)
    install -Dm644 completions/pty.bash $out/share/bash-completion/completions/pty
    install -Dm644 completions/pty.zsh $out/share/zsh/site-functions/_pty
    install -Dm644 ${fishCompletions} $out/share/fish/vendor_completions.d/pty.fish

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "Persistent terminal sessions with detach/attach support";
    homepage = "https://github.com/myobie/pty";
    license = licenses.mit;
    mainProgram = "pty";
  };
}
