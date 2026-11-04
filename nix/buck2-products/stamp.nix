# Publication identity is separate from compilation: only provenance changes.
{
  pkgs,
  compiled,
  producerCommit,
}:
assert pkgs.lib.assertMsg (builtins.match "[0-9a-f]{40}" producerCommit != null)
  "buck2-products: producerCommit must be a full lowercase Git commit";
pkgs.runCommand "${compiled.name}-stamped"
  {
    nativeBuildInputs = [ pkgs.jq ];
    passthru = {
      inherit compiled producerCommit;
      inherit (compiled) artifactName productName productKind target;
    };
  }
  ''
    mkdir -p "$out"
    cp -R ${compiled}/. "$out/"
    chmod u+w "$out/provenance.json"
    # The stamp must never transform the payload, descriptor or runtime closure.
    diff -r ${compiled} "$out"
    digest="$(sha256sum "$out/${compiled.artifactName}" | cut -d' ' -f1)"
    jq -nS \
      --arg schema 'effect-utils/buck-product-provenance/v1' \
      --arg producerCommit ${pkgs.lib.escapeShellArg producerCommit} \
      --arg target ${pkgs.lib.escapeShellArg compiled.target} \
      --arg productDigest "$digest" \
      '{schema:$schema,producerCommit:$producerCommit,target:$target,productDigest:$productDigest}' \
      > "$out/provenance.json"
    cmp ${compiled}/${compiled.artifactName} "$out/${compiled.artifactName}"
  ''
