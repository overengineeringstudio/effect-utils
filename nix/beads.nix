# Beads (bd) — pre-built binary package from GitHub releases.
# v0.56+ removed embedded Dolt entirely (CGO_ENABLED=0, pure-Go MySQL protocol).
# Requires an external `dolt sql-server` for database operations.
{ pkgs }:
let
  version = "0.56.1";
  tag = "v${version}";

  sources = {
    x86_64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_amd64.tar.gz";
      sha256 = "0p512lhdmv5h0bh1a77rn7343y5a3s80k42jzw9id8b58k26r7sg";
    };
    aarch64-linux = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_linux_arm64.tar.gz";
      sha256 = "1l4v9cwnpksk1p9v0i0vj27x7drppkcacq1q8lfxj6988c7md656";
    };
    x86_64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_amd64.tar.gz";
      sha256 = "06w5rky4qdpiqvjxqyddjxj54yg0ajdknqfj4kmq91z9fwb911y9";
    };
    aarch64-darwin = {
      url = "https://github.com/steveyegge/beads/releases/download/${tag}/beads_${version}_darwin_arm64.tar.gz";
      sha256 = "04h85wydl1hhi1jwv52w1a44afn5xln6afy0j1xc5f1avq4l72ma";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformInfo = sources.${system} or (throw "Unsupported system: ${system}");

  # CGO removed in v0.56 — only libc needed for dynamic linker on Linux
  runtimeLibs = pkgs.lib.optionals pkgs.stdenv.isLinux [
    pkgs.stdenv.cc.cc.lib
  ];
in
pkgs.stdenv.mkDerivation {
  pname = "beads";
  inherit version;

  dontBuild = true;
  dontStrip = true;

  src = pkgs.fetchurl {
    inherit (platformInfo) url sha256;
  };

  nativeBuildInputs = [ pkgs.gnutar pkgs.installShellFiles pkgs.makeWrapper ]
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

    ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
      patchelf \
        --set-interpreter "${pkgs.stdenv.cc.bintools.dynamicLinker}" \
        --set-rpath "${pkgs.lib.makeLibraryPath runtimeLibs}" \
        $out/bin/bd
    ''}

    # bd auto-starts `dolt sql-server` — ensure dolt is in PATH
    wrapProgram $out/bin/bd --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.dolt ]}
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
