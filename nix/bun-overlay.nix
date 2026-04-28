final: prev:
let
  version = "1.3.14-canary.1+ca9e0896c";

  canarySource =
    system: hash:
    final.fetchurl {
      # Bun has not published a stable bun-v1.3.14 release asset yet. The
      # canary release channel is mutable upstream, but the fixed-output hash
      # pins the exact post-module-loader-rewrite binary we want here.
      url = "https://github.com/oven-sh/bun/releases/download/canary/bun-${system}.zip";
      inherit hash;
    };
in
{
  bun = prev.bun.overrideAttrs (
    finalAttrs: prevAttrs: {
      inherit version;

      src =
        finalAttrs.passthru.sources.${prev.stdenvNoCC.hostPlatform.system}
          or (throw "Unsupported system: ${prev.stdenvNoCC.hostPlatform.system}");

      passthru = prevAttrs.passthru // {
        sources = {
          "aarch64-darwin" =
            canarySource "darwin-aarch64" "sha256-CvRCXIsSTDxEznoCwT04SDGD+GapVBazNOVyVSKuPYA=";
          "aarch64-linux" =
            canarySource "linux-aarch64" "sha256-0ys2Rh1g5rHvXy4X/XNWufIorsn5sVqT1sJathUtBFo=";
          "x86_64-darwin" =
            canarySource "darwin-x64-baseline" "sha256-yScvX5uhuUPWVz6yAwchiqdaFty/em4rc17p4xLxg1s=";
          "x86_64-linux" = canarySource "linux-x64" "sha256-Adt21Dh4wMhI7rCEdgp83xKzY4gUAOjeFkc73EaaJlA=";
        };
      };

      meta = prevAttrs.meta // {
        changelog = "https://github.com/oven-sh/bun/compare/af24e281e...ca9e0896c";
      };
    }
  );
}
