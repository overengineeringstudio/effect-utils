"""Language-neutral product payloads and build provenance."""

load("//buck2/platforms:defs.bzl", "ProductPlatformInfo")
load("@prelude//rust:crate_name.bzl", "CrateName")

BuildProvenanceInfo = provider(fields = {
    "artifact": Artifact,
    "recipe": str,
    "toolchain": str,
})

ProductExecutableInfo = provider(fields = {
    "executable": Artifact,
    "support_tree": typing.Any,
    "provenance": provider_field(BuildProvenanceInfo),
    "target_platform_abi": str,
    "target_platform_architecture": str,
    "target_platform_os": str,
    "target_platform_runtime_contract": str,
})

ProductArtifactKind = enum("executable", "library")

RustLibraryPayload = record(
    primary = field(Artifact),
    crate_name = field(CrateName),
    directory = field(Artifact),
    manifest = field(Artifact),
    compiler_metadata = field(Artifact),
    panic_strategy = field(str),
    target_triple = field(str),
    host_triple = field(str),
)

ProductArtifactInfo = provider(fields = {
    "kind": ProductArtifactKind,
    "payload": ProductExecutableInfo | RustLibraryPayload,
    "target_platform": ProductPlatformInfo,
    "provenance": BuildProvenanceInfo,
})

def product_artifact_info(kind, payload, target_platform, provenance):
    tag = ProductArtifactKind(kind)
    expected = ProductExecutableInfo if tag == ProductArtifactKind("executable") else RustLibraryPayload
    if not isinstance(payload, expected):
        fail("product_artifact_info: {} payload does not match {}".format(type(payload), kind))
    return ProductArtifactInfo(kind = tag, payload = payload, target_platform = target_platform, provenance = provenance)

def build_provenance_info(ctx, recipe, toolchain):
    """Produces the common provenance without fabricating an executable."""
    for field, value in {"recipe": recipe, "toolchain": toolchain}.items():
        if not value or "\n" in value or "\r" in value or "\x00" in value:
            fail("build_provenance {} must be a non-empty structured string".format(field))
    artifact = ctx.actions.declare_output("build-provenance.json")
    ctx.actions.write_json(artifact, {
        "recipe": recipe,
        "schema": "buck-build-provenance/v1",
        "toolchain": toolchain,
    }, pretty = True)
    return BuildProvenanceInfo(artifact = artifact, recipe = recipe, toolchain = toolchain)

def product_executable_info(ctx, executable, recipe, toolchain, target_platform, support_tree = None):
    """Builds the provider a language producer returns with its executable."""
    provenance = build_provenance_info(ctx, recipe, toolchain)
    return ProductExecutableInfo(
        executable = executable,
        support_tree = support_tree,
        provenance = provenance,
        target_platform_abi = target_platform.abi,
        target_platform_architecture = target_platform.architecture,
        target_platform_os = target_platform.os,
        target_platform_runtime_contract = target_platform.runtime_contract,
    )
