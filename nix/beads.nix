# Beads (bd) — pre-built binary package from GitHub releases.
# v0.57+ self-manages dolt sql-server per project (deterministic port from FNV hash of BEADS_DIR).
{ pkgs }:
let
  version = "0.59.0";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "0bvha0rz7qwd674s4m33f73awmx3jzmlxny3z182qcdn796mqffl";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "17xm93db6rk537djaznsw68jy5cpnzrmdm9bpzb7vfvidn3pprrv";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "0y2pp15g75dmij14as1vk5zr4qg1364h28xbqwzd8ar267w1bylf";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "0ivsr00zvb2gqiyn69rhzi65jd42vvfr5dcjkxk3ny3m68s0fpmn";
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

  nativeBuildInputs = [
    pkgs.gnutar
    pkgs.installShellFiles
    pkgs.makeWrapper
  ]
  ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.patchelf ];

  unpackPhase = ''
    mkdir -p source
    tar -xzf "$src" -C source
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp source/bd $out/bin/bd
    chmod +x $out/bin/bd

    # Patch the ELF interpreter before running the binary for completion generation.
    # autoPatchelfHook can't be used here because it runs too late (after installPhase).
    ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
      patchelf --set-interpreter "${pkgs.stdenv.cc.bintools.dynamicLinker}" $out/bin/bd
    ''}

    $out/bin/bd --help >/dev/null

    installShellCompletion --cmd bd \
      --fish <($out/bin/bd completion fish) \
      --bash <($out/bin/bd completion bash) \
      --zsh <($out/bin/bd completion zsh)

    # bd auto-starts `dolt sql-server` — ensure dolt is in PATH
    wrapProgram $out/bin/bd --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.dolt ]}
    ln -s $out/bin/bd $out/bin/beads

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "beads (bd) - An issue tracker for AI-supervised coding workflows";
    homepage = "https://github.com/steveyegge/beads";
    license = licenses.mit;
    mainProgram = "bd";
  };
}
