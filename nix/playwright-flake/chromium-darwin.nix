{ stdenv, chromium }:
stdenv.mkDerivation {
  pname = "playwright-chromium-mock-keychain";
  version = "1";
  dontUnpack = true;
  dontFixup = true;
  # The fetched bundle is an input only, never a runtime dependency.
  disallowedReferences = [ chromium ];
  buildPhase = ''
    $CC -Os -Wall -Wextra -Werror ${./chromium-launcher.c} -o chromium-launcher
  '';
  installPhase = ''
    mkdir -p "$out"
    cp -R ${chromium}/. "$out/"
    chmod -R u+w "$out"
    app=$(find "$out" -maxdepth 2 -name 'Google Chrome for Testing.app' -type d)
    test -n "$app"
    main="$app/Contents/MacOS/Google Chrome for Testing"
    mv "$main" "$main.original"
    cp chromium-launcher "$main"

    # Sign individual Mach-O files before their containing framework/app bundles.
    # Keep identifiers and entitlements on existing code. The main bundle keeps
    # upstream's linker identifier as well as its unchanged CFBundleIdentifier.
    while IFS= read -r -d $'\0' file; do
      if /usr/bin/file -b "$file" | grep -q 'Mach-O'; then
        identifier=$(/usr/bin/codesign -dv "$file" 2>&1 | grep '^Identifier=' | cut -d= -f2-)
        test -n "$identifier"
        /usr/bin/codesign --force --sign - --identifier "$identifier" --preserve-metadata=entitlements,flags "$file"
      fi
    done < <(find "$app" -type f -print0)
    while IFS= read -r -d $'\0' bundle; do
      if [ "$bundle" = "$app" ]; then
        /usr/bin/codesign --force --sign - --identifier 'Google Chrome for Testing' "$bundle"
      else
        identifier=$(/usr/bin/codesign -dv "$bundle" 2>&1 | grep '^Identifier=' | cut -d= -f2-)
        test -n "$identifier"
        /usr/bin/codesign --force --sign - --identifier "$identifier" --preserve-metadata=entitlements,flags "$bundle"
      fi
    done < <(find "$app" -depth -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0)
    /usr/bin/codesign --verify --deep --strict "$app"
  '';
}
