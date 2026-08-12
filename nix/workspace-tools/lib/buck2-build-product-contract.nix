# Pure, exact validation and canonicalization for buck-build-product/v1.
# Runtime inspection and artifact realization deliberately live outside this
# module: accepting a descriptor shape is not proof that its runtime is usable.
let
  fail = message: throw "buck2-build-product-contract: ${message}";
  ensure = condition: message: if condition then true else fail message;
  force = checks: value: builtins.deepSeq checks value;
  nonEmptyString = value: builtins.isString value && value != "";

  exactAttrs =
    path: expected: value:
    if !builtins.isAttrs value then
      fail "${path} must be an attribute set"
    else
      let
        actual = builtins.attrNames value;
        unknown = builtins.filter (name: !(builtins.elem name expected)) actual;
        missing = builtins.filter (name: !(builtins.elem name actual)) expected;
      in
      if unknown != [ ] then
        fail "${path} has unknown fields: ${builtins.concatStringsSep ", " unknown}"
      else if missing != [ ] then
        fail "${path} is missing fields: ${builtins.concatStringsSep ", " missing}"
      else
        value;

  unique =
    values:
    if values == [ ] then
      true
    else
      !(builtins.elem (builtins.head values) (builtins.tail values)) && unique (builtins.tail values);

  validateStringList =
    path: values:
    force [
      (ensure (builtins.isList values) "${path} must be a list")
      (ensure (builtins.all nonEmptyString values) "${path} entries must be non-empty strings")
      (ensure (unique values) "${path} entries must be unique")
    ] values;

  safePath =
    value:
    nonEmptyString value
    && builtins.substring 0 1 value != "/"
    && builtins.match ".*\\\\.*" value == null
    && builtins.all (component: component != "" && component != "." && component != "..") (
      builtins.filter builtins.isString (builtins.split "/" value)
    );

  validateRuntime =
    runtime:
    if !builtins.isAttrs runtime then
      fail "descriptor.runtime must be an attribute set"
    else if !(runtime ? kind) then
      fail "descriptor.runtime is missing fields: kind"
    else if !nonEmptyString runtime.kind then
      fail "descriptor.runtime.kind must be a non-empty string"
    else
      let
        kind = runtime.kind;
      in
      if kind == "interpreter" then
        let
          value = exactAttrs "descriptor.runtime" [
            "kind"
            "program"
            "runtimeContract"
            "runtimeId"
          ] runtime;
        in
        force [
          (ensure (nonEmptyString value.runtimeId) "descriptor.runtime.runtimeId must be a non-empty string")
          (ensure (nonEmptyString value.runtimeContract) "descriptor.runtime.runtimeContract must be a non-empty string")
          (ensure (safePath value.program) "descriptor.runtime.program must be a safe relative path")
        ] value
      else if kind == "elf-dynamic" then
        let
          value = exactAttrs "descriptor.runtime" [
            "kind"
            "loaderClass"
            "machine"
            "neededLibraries"
            "runpathPolicy"
            "symbolVersionFloors"
          ] runtime;
        in
        force [
          (ensure (nonEmptyString value.machine) "descriptor.runtime.machine must be a non-empty string")
          (ensure (nonEmptyString value.loaderClass) "descriptor.runtime.loaderClass must be a non-empty string")
          (validateStringList "descriptor.runtime.neededLibraries" value.neededLibraries)
          (validateStringList "descriptor.runtime.symbolVersionFloors" value.symbolVersionFloors)
          (ensure (nonEmptyString value.runpathPolicy) "descriptor.runtime.runpathPolicy must be a non-empty string")
        ] value
      else if kind == "mach-o-dynamic" then
        let
          value = exactAttrs "descriptor.runtime" [
            "architecture"
            "dylibs"
            "installNamePolicy"
            "kind"
            "minimumOs"
            "rpathPolicy"
            "signingPolicy"
          ] runtime;
        in
        force [
          (ensure (nonEmptyString value.architecture) "descriptor.runtime.architecture must be a non-empty string")
          (ensure (nonEmptyString value.minimumOs) "descriptor.runtime.minimumOs must be a non-empty string")
          (validateStringList "descriptor.runtime.dylibs" value.dylibs)
          (ensure (nonEmptyString value.installNamePolicy) "descriptor.runtime.installNamePolicy must be a non-empty string")
          (ensure (nonEmptyString value.rpathPolicy) "descriptor.runtime.rpathPolicy must be a non-empty string")
          (ensure (nonEmptyString value.signingPolicy) "descriptor.runtime.signingPolicy must be a non-empty string")
        ] value
      else if kind == "self-contained" then
        let
          value = exactAttrs "descriptor.runtime" [
            "inspectionContract"
            "kind"
          ] runtime;
        in
        force [
          (ensure (nonEmptyString value.inspectionContract) "descriptor.runtime.inspectionContract must be a non-empty string")
        ] value
      else
        fail "unsupported runtime kind: ${toString kind}";

  validateDescriptor =
    descriptor:
    let
      value = exactAttrs "descriptor" [
        "entrypoints"
        "name"
        "payload"
        "platform"
        "runtime"
        "schema"
        "semanticProvenance"
      ] descriptor;
      platform = exactAttrs "descriptor.platform" [
        "abi"
        "architecture"
        "os"
      ] value.platform;
      payload = exactAttrs "descriptor.payload" [
        "digest"
        "file"
        "format"
        "sizeBytes"
      ] value.payload;
      digest = exactAttrs "descriptor.payload.digest" [
        "algorithm"
        "sri"
      ] payload.digest;
      semanticProvenance = exactAttrs "descriptor.semanticProvenance" [
        "recipe"
        "target"
        "toolchain"
      ] value.semanticProvenance;
      entrypoints = validateStringList "descriptor.entrypoints" value.entrypoints;
      runtime = validateRuntime value.runtime;
    in
    force [
      (ensure (value.schema == "buck-build-product/v1") "unsupported descriptor schema")
      (ensure (
        nonEmptyString value.name && builtins.match "[A-Za-z0-9._+-]+" value.name != null
      ) "descriptor.name is invalid")
      (ensure (nonEmptyString platform.os) "descriptor.platform.os must be a non-empty string")
      (ensure (nonEmptyString platform.architecture) "descriptor.platform.architecture must be a non-empty string")
      (ensure (nonEmptyString platform.abi) "descriptor.platform.abi must be a non-empty string")
      (ensure (payload.file == "artifact.tar") "descriptor.payload.file must be artifact.tar")
      (ensure (payload.format == "tar") "descriptor.payload.format must be tar")
      (ensure (digest.algorithm == "sha256") "descriptor.payload.digest.algorithm must be sha256")
      (ensure (
        nonEmptyString digest.sri && builtins.match "sha256-[A-Za-z0-9+/]{43}=" digest.sri != null
      ) "descriptor.payload.digest.sri must be a sha256 SRI digest")
      (ensure (
        builtins.isInt payload.sizeBytes && payload.sizeBytes > 0
      ) "descriptor.payload.sizeBytes must be a positive integer")
      (ensure (entrypoints != [ ]) "descriptor.entrypoints must not be empty")
      (ensure (builtins.all safePath entrypoints) "descriptor.entrypoints must be safe relative paths")
      (ensure (
        runtime.kind != "interpreter" || builtins.elem runtime.program entrypoints
      ) "descriptor.runtime.program must name a declared entrypoint")
      (ensure (nonEmptyString semanticProvenance.target) "descriptor.semanticProvenance.target must be a non-empty string")
      (ensure (nonEmptyString semanticProvenance.recipe) "descriptor.semanticProvenance.recipe must be a non-empty string")
      (ensure (nonEmptyString semanticProvenance.toolchain) "descriptor.semanticProvenance.toolchain must be a non-empty string")
    ] value;

  canonicalDescriptorJson = descriptor: builtins.toJSON (validateDescriptor descriptor);
  descriptorDigest =
    descriptor: "sha256:${builtins.hashString "sha256" (canonicalDescriptorJson descriptor)}";
in
{
  inherit
    canonicalDescriptorJson
    descriptorDigest
    validateDescriptor
    validateRuntime
    ;

  verifyDescriptor =
    { descriptor, expectedDescriptorDigest }:
    let
      expectedCheck = ensure (
        nonEmptyString expectedDescriptorDigest
        && builtins.match "sha256:[0-9a-f]{64}" expectedDescriptorDigest != null
      ) "expectedDescriptorDigest must be a sha256 digest";
      actual = descriptorDigest descriptor;
      digestCheck = ensure (
        actual == expectedDescriptorDigest
      ) "descriptor digest mismatch: expected ${expectedDescriptorDigest}, got ${actual}";
    in
    force [
      expectedCheck
      digestCheck
    ] (validateDescriptor descriptor);
}
