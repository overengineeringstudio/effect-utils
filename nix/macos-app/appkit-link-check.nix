{ pkgs, nixpkgsRevision }:
let
  capability = import ../workspace-tools/lib/buck2-darwin-rust-capability.nix {
    inherit pkgs nixpkgsRevision;
  };
  source = pkgs.writeText "appkit-link-probe.rs" ''
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" { static NSApp: *mut std::ffi::c_void; }
    fn main() {
        // Linking and reading the native singleton does not instantiate NSApplication.
        assert!(unsafe { NSApp.is_null() });
        println!("AppKit linkage (no application/window): PASS");
    }
  '';
in
pkgs.runCommand "macos-app-appkit-link-check" { } ''
  ${capability.compiler}/bin/rustc --crate-name appkit_link_probe '${source}' -o probe
  mkdir -p "$out"
  ./probe > "$out/result"
''
