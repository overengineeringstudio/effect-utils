{
  fetchzip,
  browserVersion,
  system,
  stdenv,
  autoPatchelfHook,
  patchelfUnstable,

  alsa-lib,
  at-spi2-atk,
  expat,
  glib,
  libXcomposite,
  libXdamage,
  libXfixes,
  libXrandr,
  libgbm,
  libgcc,
  libxkbcommon,
  nspr,
  nss,
  ...
}:
let
  linux = stdenv.mkDerivation {
    name = "playwright-chromium-headless-shell";
    src = fetchzip {
      url =
        "https://cdn.playwright.dev/builds/cft/${browserVersion}/linux64/"
        + "chrome-headless-shell-linux64.zip";
      stripRoot = false;
      hash = "sha256-/xskLzTc9tTZmu1lwkMpjV3QV7XjP92D/7zRcFuVWT8=";
    };

    nativeBuildInputs = [
      autoPatchelfHook
      patchelfUnstable
    ];

    buildInputs = [
      alsa-lib
      at-spi2-atk
      expat
      glib
      libXcomposite
      libXdamage
      libXfixes
      libXrandr
      libgbm
      libgcc.lib
      libxkbcommon
      nspr
      nss
    ];

    buildPhase = ''
      cp -R . $out
    '';
  };

  darwin = fetchzip {
    url =
      "https://cdn.playwright.dev/builds/cft/${browserVersion}/"
      + (
        if system == "aarch64-darwin"
        then "mac-arm64/chrome-headless-shell-mac-arm64.zip"
        else "mac-x64/chrome-headless-shell-mac-x64.zip"
      );
    stripRoot = false;
    hash =
      {
        x86_64-darwin = "sha256-qXeSBKiJDlmTur6oFc+bIxJEiI1ajUh5F8K7EmZcDK0=";
        aarch64-darwin = "sha256-MSefpMybq6wufJ9+2iSO3Vnk4OQmlYu1DfUODLgFh78=";
      }
      .${system};
  };
in
{
  x86_64-linux = linux;
  x86_64-darwin = darwin;
  aarch64-darwin = darwin;
}
.${system}
