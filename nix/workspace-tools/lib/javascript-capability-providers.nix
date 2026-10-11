# Realize only capabilities admitted by the consumer, selected by pinned bytes.
{ lib }:
{ required, providers }:
let
  unknown = builtins.filter (name: !(builtins.hasAttr name providers)) required;
  selected = map (name: providers.${name}) required;
in
assert lib.assertMsg (unknown == [ ])
  "javascript-capability-providers: unregistered capabilities: ${builtins.concatStringsSep ", " unknown}";
{
  capabilities = map (provider: provider.capability) selected;
  environment = builtins.foldl' (result: provider: result // (provider.environment or { })) { } selected;
  pathPackages = builtins.concatLists (map (provider: provider.pathPackages or [ ]) selected);
  nativeNodePackages = builtins.concatLists (map (provider: provider.nativeNodePackages or [ ]) selected);
  externalModules = builtins.concatLists (map (provider: provider.externalModules or [ ]) selected);
}
