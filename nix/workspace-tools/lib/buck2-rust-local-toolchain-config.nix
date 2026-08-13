{ pkgs }:

{
  rustc,
  linker,
  targetTriple ? "x86_64-unknown-linux-musl",
}:

let
  contract = "effect-utils/rust-local-store-toolchain/v1";
  executionPlatform = "//buck2/platforms:exec_x86_64_linux_local_store";
  targetPlatform = "//buck2/platforms:target_x86_64_linux_musl_static";
  identity = builtins.hashString "sha256" (
    builtins.toJSON {
      inherit
        contract
        executionPlatform
        linker
        rustc
        targetPlatform
        targetTriple
        ;
    }
  );
in
{
  inherit identity;

  # One immutable file carries paths and semantic claims together. Buck still
  # enforces its configured target/execution constraints independently.
  config = pkgs.writeText "buck2-rust-local-toolchain.conf" ''
    [build]
      execution_platforms = ${executionPlatform}

    [rust_toolchain]
      contract = ${contract}
      execution_platform = ${executionPlatform}
      linker = ${linker}
      rustc = ${rustc}
      target_platform = ${targetPlatform}
      target_triple = ${targetTriple}
      toolchain_identity = sha256:${identity}
  '';
}
