let
  plan = import ./buck2-product-composition-plan.nix;
  # Minimal prevalidated compatibility records; schema validation belongs to the importer.
  library = {
    name = "library";
    kind = "library";
    platform = "linux";
    semanticProvenance.toolchain = "contract=effect-utils/buck2-rust-toolchain/v1;pinned";
    library = {
      targetTriple = "target";
      hostTriple = "host";
      panicStrategy = "unwind";
      rustc = {
        compilerStorePath = "compiler";
        sysroot = "sysroot";
        verboseVersion = "version";
      };
      artifacts = [ { path = "lib/library.rlib"; } ];
    };
  };
  other = library // {
    name = "other";
    library = library.library // {
      artifacts = [ { path = "lib/other.rlib"; } ];
    };
  };
  rejects =
    d:
    !(builtins.tryEval (
      builtins.deepSeq (plan [
        library
        d
      ]) true
    )).success;
  change = attrs: other // { library = other.library // attrs; };
in
assert rejects (other // { platform = "darwin"; });
assert rejects (change {
  rustc = other.library.rustc // {
    compilerStorePath = "different";
  };
});
assert rejects (change {
  rustc = other.library.rustc // {
    sysroot = "different";
  };
});
assert rejects (change {
  targetTriple = "different";
});
assert rejects (change {
  panicStrategy = "abort";
});
assert rejects (other // { library = library.library; });
assert rejects {
  name = "tool";
  platform = "linux";
  entrypoints = [ "bin/tool" ];
  semanticProvenance.toolchain = "contract=effect-utils/buck2-rust-toolchain/v1;different";
};
assert builtins.deepSeq (plan [
  library
  other
]) true;
true
