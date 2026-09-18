"""Dependency-only aggregates for repository check entry points."""


def _check_aggregate_impl(ctx):
    outputs = []
    for target in ctx.attrs.targets:
        info = target[DefaultInfo]
        outputs.extend(info.default_outputs)
        outputs.extend(info.other_outputs)
    return [DefaultInfo(other_outputs = outputs)]


check_aggregate = rule(
    impl = _check_aggregate_impl,
    attrs = {
        "targets": attrs.list(attrs.dep()),
    },
)
