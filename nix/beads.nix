# Beads (bd) — pre-built binary package from GitHub releases.
# Upstream flake (github:steveyegge/beads) can't build from source due to
# Go version mismatch in nixpkgs, so we fetch the pre-built binary instead.
{ pkgs }:
let
  version = "0.55.4";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "0jazd9189vf5j6z692670i8rkgx090s6a5zg1qir0a6qdm2jbyp0";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "1bxydkk3qqr8wbh5j64wi8h4l0dfskw9q4g7chvqyxqh7r32lg17";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "11427xlz86l1aq8qcmxczaiakmqfz5a4zj2vxca2wqjfidl738rr";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "1ff001pigbwwlyj7dcb1sglawl3pqaayvxxjhwbaf8r3ar7xzbqq";
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
