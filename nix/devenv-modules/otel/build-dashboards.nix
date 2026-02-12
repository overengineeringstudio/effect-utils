# Standalone build helper for compiling Grafonnet dashboards.
#
# Projects import this to compile their Jsonnet sources against Grafonnet
# and the shared effect-utils dashboard library (lib.libsonnet, g.libsonnet).
#
# Usage:
#   let
#     dashboards = effectUtils.lib.buildOtelDashboards {
#       inherit pkgs;
#       src = ./nix/otel-dashboards;
#       dashboardNames = [ "my-overview" "my-traces" ];
#     };
#   in
#   # dashboards is a Nix store path (linkFarm) containing compiled JSON files
#   (effectUtils.devenvModules.otel {
#     extraDashboards = [{ name = "my-project"; path = dashboards; }];
#   })
{
  pkgs,
  # Directory containing *.jsonnet source files and any project-local libsonnet
  src,
  # List of dashboard names to compile (each must have a corresponding .jsonnet file in src)
  dashboardNames,
}:
let
  grafonnetSrc = pkgs.fetchFromGitHub {
    owner = "grafana";
    repo = "grafonnet";
    rev = "7380c9c64fb973f34c3ec46265621a2b0dee0058";
    sha256 = "sha256-WS3Z/k9fDSleK6RVPTFQ9Um26GRFv/kxZhARXpGkS10=";
  };

  xtdSrc = pkgs.fetchFromGitHub {
    owner = "jsonnet-libs";
    repo = "xtd";
    rev = "4d7f8cb24d613430799f9d56809cc6964f35cea9";
    sha256 = "sha256-MWinI7gX39UIDVh9kzkHFH6jsKZoI294paQUWd/4+ag=";
  };

  docsonnetSrc = pkgs.fetchFromGitHub {
    owner = "jsonnet-libs";
    repo = "docsonnet";
    rev = "6ac6c69685b8c29c54515448eaca583da2d88150";
    sha256 = "sha256-Uy86lIQbFjebNiAAp0dJ8rAtv16j4V4pXMPcl+llwBA=";
  };

  builtinDashboardsSrcDir = ./dashboards;

  grafonnetJpath = pkgs.linkFarm "grafonnet-jpath" [
    {
      name = "github.com/grafana/grafonnet";
      path = grafonnetSrc;
    }
    {
      name = "github.com/jsonnet-libs/xtd";
      path = xtdSrc;
    }
    {
      name = "github.com/jsonnet-libs/docsonnet";
      path = docsonnetSrc;
    }
  ];

  buildDashboard = name:
    pkgs.runCommand "grafana-dashboard-${name}"
      { nativeBuildInputs = [ pkgs.go-jsonnet ]; }
      ''
        mkdir -p $out
        jsonnet \
          -J ${grafonnetJpath} \
          -J ${grafonnetSrc} \
          -J ${builtinDashboardsSrcDir} \
          -J ${src} \
          ${src}/${name}.jsonnet \
          -o $out/${name}.json
      '';
in
pkgs.linkFarm "otel-dashboards-extra" (
  map (name: {
    name = "${name}.json";
    path = "${buildDashboard name}/${name}.json";
  }) dashboardNames
)
