{
  pkgs,
  guest,
  release,
  catalogDigest,
  epoch,
}:
pkgs.runCommand "immutable-authority-release-${release}" { } ''
  mkdir -p $out
  ln -s ${guest.config.microvm.declaredRunner} $out/runner
  cp ${
    pkgs.writeText "manifest.json" (builtins.toJSON { inherit release catalogDigest epoch; })
  } $out/manifest.json
''
