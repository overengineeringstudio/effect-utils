"""Exact resource-byte parity over existing declared source ownership."""

load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_attrs", "hermetic_bun_command", "hermetic_execution_constraints")
load("//buck2:static_checks.bzl", "StaticSourceSetInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

def _byte_parity_impl(ctx):
    sources = {}
    for target in ctx.attrs.source_sets:
        source_set = target[StaticSourceSetInfo]
        for source in source_set.files:
            path = source_set.prefix + "/" + source.short_path if source_set.prefix else source.short_path
            sources[path] = source
    output = ctx.actions.declare_output("parity.json")
    script = ctx.actions.write("check.mjs", """
const [output, ...pairs] = process.argv.slice(2);
for (let i = 0; i < pairs.length; i += 2) {
  const left = await Bun.file(pairs[i]).bytes();
  const right = await Bun.file(pairs[i + 1]).bytes();
  if (Buffer.compare(left, right) !== 0) throw new Error(`resource bytes differ: ${pairs[i]} != ${pairs[i + 1]}`);
}
await Bun.write(output, JSON.stringify({ pairs: pairs.length / 2 }));
""")
    args = cmd_args(hermetic_bun_command(ctx, ctx.attrs._javascript[EffectTsgoToolchainInfo].bun), script, output.as_output())
    for left, right in ctx.attrs.pairs.items():
        if left not in sources or right not in sources:
            fail("byte parity inputs must belong to declared source sets: {} / {}".format(left, right))
        args.add(sources[left], sources[right])
    hermetic_action(ctx, args, category = "resource_byte_parity", identifier = ctx.attrs.name, local_only = True)
    return [DefaultInfo(default_output = output)]

_byte_parity = cache_guarded_rule(
    impl = _byte_parity_impl,
    cache_eligible = lambda ctx: True,
    attrs = dict(hermetic_attrs(), **{
        "pairs": attrs.dict(key = attrs.string(), value = attrs.string()),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "_javascript": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:effect_tsgo", providers = [EffectTsgoToolchainInfo])),
    }),
)

def byte_parity(name, pairs, source_sets, **kwargs):
    """Compare exact bytes; missing ownership fails analysis, mismatch fails the action."""
    kwargs["exec_compatible_with"] = hermetic_execution_constraints(kwargs.get("exec_compatible_with", []))
    _byte_parity(name = name, pairs = pairs, source_sets = source_sets, **kwargs)
