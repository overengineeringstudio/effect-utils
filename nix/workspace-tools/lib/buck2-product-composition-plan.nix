# Compatibility checks for descriptors already validated by the product contract.
descriptors:
let
  libraries = builtins.filter (d: (d.kind or null) == "library") descriptors;
  first = builtins.head libraries;
  ensure = condition: message: if condition then true else throw "Buck composition: ${message}";
  entries = builtins.sort (a: b: a.path < b.path) (
    builtins.concatMap (
      d:
      map (path: {
        inherit path;
        owner = d.name;
      }) (if (d.kind or null) == "library" then map (a: a.path) d.library.artifacts else d.entrypoints)
    ) descriptors
  );
  collisionChecks = builtins.genList (
    i:
    let
      a = builtins.elemAt entries i;
    in
    builtins.all
      (
        b:
        ensure (
          a.path != b.path && builtins.substring 0 (builtins.stringLength a.path + 1) b.path != "${a.path}/"
        ) "destination collision ${b.path}: ${a.owner}, ${b.owner}"
      )
      (
        builtins.filter (b: b.index > i) (
          builtins.genList (j: (builtins.elemAt entries j) // { index = j; }) (builtins.length entries)
        )
      )
  ) (builtins.length entries);
  identity = d: {
    inherit (d.library) targetTriple hostTriple panicStrategy;
    rustc = builtins.removeAttrs d.library.rustc [ "darwinWrapperEvidence" ];
  };
  checks = map (
    d:
    ensure (d.platform == first.platform) "platform mismatch: ${first.name}, ${d.name}"
    && (
      if (d.kind or null) == "library" then
        ensure (identity d == identity first) "Rust library identity mismatch: ${first.name}, ${d.name}"
      else if
        builtins.match "contract=effect-utils/buck2-rust-toolchain/v1;.*" d.semanticProvenance.toolchain
        != null
      then
        ensure (
          d.semanticProvenance.toolchain == first.semanticProvenance.toolchain
        ) "Rust executable toolchain mismatch: ${first.name}, ${d.name}"
      else
        true
    )
  ) descriptors;
in
assert ensure (libraries != [ ]) "at least one library is required";
assert builtins.all (x: x) checks;
assert builtins.all (x: x) collisionChecks;
{
  inherit descriptors;
  library = first;
}
