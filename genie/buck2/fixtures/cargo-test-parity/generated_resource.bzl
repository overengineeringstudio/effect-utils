def _generated_resource_impl(ctx):
    output = ctx.actions.write("generated.txt", "generated resource\n")
    return [DefaultInfo(default_output = output)]

# Deliberately no genrule shell, host command, or local source artifact.
generated_resource = rule(impl = _generated_resource_impl, attrs = {})
