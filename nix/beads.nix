# Beads (bd) — pre-built binary package from GitHub releases.
# Upstream flake (github:steveyegge/beads) can't build from source due to
# Go version mismatch in nixpkgs, so we fetch the pre-built binary instead.
{ pkgs }:
let
  version = "0.49.6";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "1f3xpczha8r6nv5k42c5j5g9g466m4j056mwq8dc67g18yddqil5";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "05iyf86mhc102vim8fcvcmn15gd3rblncpbh3hn212r62jbxmms3";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "0qmwcc722xbd461dmscwvbmy3dghd5aj49sxb2axy0lsbay8m9xr";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "0zdbv5inmzfjcf0kmi02vq1yj17g0p9smdpcl2ilib7f37csqz80";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformInfo = sources.${system} or (throw "Unsupported system: ${system}");
in
pkgs.stdenv.mkDerivation {
  pname = "beads";
  inherit version;

  dontBuild = true;
  dontStrip = true;

  src = pkgs.fetchurl {
    inherit (platformInfo) url sha256;
  };

  nativeBuildInputs = [ pkgs.gnutar pkgs.installShellFiles ];

  unpackPhase = ''
    mkdir -p source
    tar -xzf "$src" -C source
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp source/bd $out/bin/bd
    chmod +x $out/bin/bd
    ln -s $out/bin/bd $out/bin/beads

    installShellCompletion --cmd bd \
      --fish <($out/bin/bd completion fish) \
      --bash <($out/bin/bd completion bash) \
      --zsh <($out/bin/bd completion zsh)

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "beads (bd) - An issue tracker for AI-supervised coding workflows";
    homepage = "https://github.com/steveyegge/beads";
    license = licenses.mit;
    mainProgram = "bd";
  };
}
