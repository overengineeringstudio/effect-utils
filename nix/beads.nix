# Beads (bd) — pre-built binary package from GitHub releases.
# v0.57+ self-manages dolt sql-server per project (deterministic port from FNV hash of BEADS_DIR).
{ pkgs }:
let
  version = "0.57.0";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "0jy0blh895iask2hi7gdkagnf78pvjnk88zr0rgx5mxy4xb9sqpq";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "1a5gn5kn8gf8a1923z19h4wz8vc483vy51q71q591wyvd5dnpk44";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "0x72ylyv0n8riy9d9kxylfrdcpdydsm589i5xkr9i8pag4ns76i8";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "1vcc6dm85in4hb8ik6c863l76p9hhp14r7ckpqpzfafsckzvvg7v";
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
