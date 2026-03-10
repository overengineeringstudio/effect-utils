{
  runCommand,
  makeWrapper,
  fontconfig_file,
  fetchzip,
  browserVersion,
  system,
  lib,
  alsa-lib,
  at-spi2-atk,
  atk,
  autoPatchelfHook,
  cairo,
  cups,
  dbus,
  expat,
  glib,
  gobject-introspection,
  libGL,
  libgbm,
  libgcc,
  libxkbcommon,
  nspr,
  nss,
  pango,
  patchelf,
  pciutils,
  stdenv,
  systemd,
  vulkan-loader,
  libX11,
  libXcomposite,
  libXdamage,
  libXext,
  libXfixes,
  libXrandr,
  libxcb,
  ...
}:
let
  chromium-linux = stdenv.mkDerivation {
    name = "playwright-chromium";
    src = fetchzip {
      url = "https://cdn.playwright.dev/builds/cft/${browserVersion}/linux64/chrome-linux64.zip";
      hash = "sha256-dJSO05xOzlSl/EwOWNQCeuSb+lhUU6NlGBnRu59irnM=";
    };

    nativeBuildInputs = [
      autoPatchelfHook
      patchelf
      makeWrapper
    ];
    buildInputs = [
      alsa-lib
      at-spi2-atk
      atk
      cairo
      cups
      dbus
      expat
      glib
      gobject-introspection
      libgbm
      libgcc
      libxkbcommon
      nspr
      nss
      pango
      stdenv.cc.cc.lib
      systemd
      libX11
      libXcomposite
      libXdamage
      libXext
      libXfixes
      libXrandr
      libxcb
    ];

    installPhase = ''
      runHook preInstall

      mkdir -p $out/chrome-linux64
      cp -R . $out/chrome-linux64

      wrapProgram $out/chrome-linux64/chrome \
        --set-default SSL_CERT_FILE /etc/ssl/certs/ca-bundle.crt \
        --set-default FONTCONFIG_FILE ${fontconfig_file}

      runHook postInstall
    '';

    appendRunpaths = lib.makeLibraryPath [
      libGL
      vulkan-loader
      pciutils
    ];

    postFixup = ''
      rm "$out/chrome-linux64/libvulkan.so.1"
      ln -s -t "$out/chrome-linux64" "${lib.getLib vulkan-loader}/lib/libvulkan.so.1"
    '';
  };

  chromium-darwin = fetchzip {
    url =
      "https://cdn.playwright.dev/builds/cft/${browserVersion}/"
      + (if system == "aarch64-darwin" then "mac-arm64/chrome-mac-arm64.zip" else "mac-x64/chrome-mac-x64.zip");
    stripRoot = false;
    hash =
      {
        x86_64-darwin = "sha256-+jpk7PuOK4bEurrGt3Z60uY50k4YgtlL2DxTwp/wbbg=";
        aarch64-darwin = "sha256-qXdgHeBS5IFIa4hZVmjq0+31v/uDPXHyc4aH7Wn2E7E=";
      }
      .${system};
  };
in
{
  x86_64-linux = chromium-linux;
  x86_64-darwin = chromium-darwin;
  aarch64-darwin = chromium-darwin;
}
.${system}
