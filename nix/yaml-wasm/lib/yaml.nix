/** YAML <-> Nix conversion via builtins.wasm.
  * Requires: extra-experimental-features = wasm-builtin */
{ wasmPath }:
let
  /** Rebuild a value tree using mapAttrs so builtins.wasm can serialize it.
    * Works around a Determinate Nix bug where merged attrsets (from //) crash copy_attrname. */
  materialize = value:
    if builtins.isAttrs value then builtins.mapAttrs (_: materialize) value
    else if builtins.isList value then map materialize value
    else value;
in
{
  /** Parse a YAML string -> Nix attrset (first document) */
  fromYAML = yaml: builtins.head (builtins.wasm wasmPath "fromYAML" yaml);
  /** Parse a multi-document YAML string -> list of Nix attrsets */
  fromYAMLMulti = yaml: builtins.wasm wasmPath "fromYAML" yaml;
  /** Emit a Nix attrset -> YAML string */
  toYAML = value: builtins.wasm wasmPath "toYAML" [ (materialize value) ];
}
