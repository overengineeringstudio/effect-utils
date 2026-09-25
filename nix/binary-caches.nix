let
  descriptors = builtins.fromJSON (builtins.readFile ./binary-caches.json);
  isString = builtins.isString;
  nonEmpty = value: isString value && value != "" && builtins.match ".*[[:space:]].*" value == null;
  fieldsAre =
    value: fields:
    builtins.sort builtins.lessThan (builtins.attrNames value)
    == builtins.sort builtins.lessThan fields;
  valid =
    name: cache:
    builtins.isAttrs cache
    && builtins.hasAttr "kind" cache
    && builtins.hasAttr "name" cache
    && builtins.hasAttr "visibility" cache
    && cache.name == name
    && nonEmpty cache.name
    && builtins.elem cache.visibility [
      "public"
      "private"
    ]
    && (
      if cache.kind == "nix-binary" then
        fieldsAre cache [
          "kind"
          "name"
          "visibility"
          "uri"
          "publicKey"
        ]
        && nonEmpty cache.uri
        && builtins.match "https://[^[:space:]]+" cache.uri != null
        && nonEmpty cache.publicKey
        && builtins.match "[^:[:space:]]+:[^[:space:]]+" cache.publicKey != null
      else if cache.kind == "reapi" then
        fieldsAre cache [
          "kind"
          "name"
          "visibility"
          "endpoint"
          "instanceName"
          "digest"
        ]
        && nonEmpty cache.endpoint
        && builtins.match "grpcs?://[^[:space:]]+" cache.endpoint != null
        && nonEmpty cache.instanceName
        && cache.digest == "SHA256"
      else
        false
    );
in
assert builtins.isAttrs descriptors;
assert builtins.all (name: valid name descriptors.${name}) (builtins.attrNames descriptors);
descriptors
