{
  pkgs,
  lib ? pkgs.lib,
}:

let
  version = "1.1.0";
  nodeAddonApi = pkgs.fetchurl {
    url = "https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.1.0.tgz";
    hash = "sha512-mNcltoe1R8o7STTegSOHdnJNN7s5EUvhoS7ShnTHDyOSd+8H+UdWODq6qSv67PjC8Zc5JRT8+oLAMCr0SIXw7g==";
  };
in
pkgs.stdenv.mkDerivation {
  pname = "node-pty-native";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/node-pty/-/node-pty-${version}.tgz";
    hash = "sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==";
  };

  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.node-gyp
    pkgs.python3
    pkgs.pkg-config
  ];

  buildInputs = lib.optionals pkgs.stdenv.isLinux [
    pkgs.util-linux
  ];

  unpackPhase = ''
    runHook preUnpack
    mkdir source
    tar -xzf "$src" -C source --strip-components=1
    cd source
    runHook postUnpack
  '';

  configurePhase = ''
    runHook preConfigure
    export HOME="$TMPDIR"
    export npm_config_nodedir="${pkgs.nodejs}"
    mkdir -p node_modules/node-addon-api
    tar -xzf ${nodeAddonApi} -C node_modules/node-addon-api --strip-components=1
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    node-gyp rebuild --nodedir="${pkgs.nodejs}"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    package_dir="$out/node_modules/node-pty"
    mkdir -p "$package_dir"
    cp -R binding.gyp lib package.json scripts src typings "$package_dir"/
    mkdir -p "$package_dir/node_modules"
    cp -R node_modules/node-addon-api "$package_dir/node_modules/node-addon-api"
    if [ -d deps ]; then cp -R deps "$package_dir"/; fi
    if [ -d third_party ]; then cp -R third_party "$package_dir"/; fi
    mkdir -p "$package_dir/build"
    cp -R build/Release "$package_dir/build/Release"
    runHook postInstall
  '';

  passthru = {
    name = "node-pty";
    package = "${placeholder "out"}/node_modules/node-pty";
  };

  meta = {
    description = "Nix-built node-pty native addon for pure pnpm installs";
    homepage = "https://github.com/microsoft/node-pty";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
