# Beads (bd) — built from source with CGO for Dolt support.
# CGO is required for go-icu-regex; non-CGO builds lack `bd dolt push/pull/commit`.
{ pkgs }:
let
  version = "0.55.4";
in
pkgs.buildGo126Module {
  pname = "beads";
  inherit version;

  src = pkgs.fetchFromGitHub {
    owner = "steveyegge";
    repo = "beads";
    rev = "v${version}";
    hash = "sha256-HTcmGKn2NNoBEg5yRsnVIATNdte5Xw8E86D09e1X5nk=";
  };

  vendorHash = "sha256-cMvxGJBMUszIbWwBNmWe+ws4m3mfyEZgapxVYNYc5c4=";
  subPackages = [ "cmd/bd" ];
  doCheck = false;

  nativeBuildInputs = [ pkgs.installShellFiles pkgs.pkg-config ];
  buildInputs = [ pkgs.icu ];

  env.CGO_ENABLED = 1;

  postInstall = ''
    ln -s $out/bin/bd $out/bin/beads

    installShellCompletion --cmd bd \
      --fish <($out/bin/bd completion fish) \
      --bash <($out/bin/bd completion bash) \
      --zsh <($out/bin/bd completion zsh)
  '';

  meta = with pkgs.lib; {
    description = "beads (bd) - An issue tracker for AI-supervised coding workflows";
    homepage = "https://github.com/steveyegge/beads";
    license = licenses.mit;
    mainProgram = "bd";
  };
}
