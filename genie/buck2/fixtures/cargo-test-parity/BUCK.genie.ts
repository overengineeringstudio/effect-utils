import { createGenieOutput } from '../../../../packages/@overeng/genie/src/runtime/core.ts'

const content = `load("@prelude//:prelude.bzl", "native")
load(":generated_resource.bzl", "generated_resource")

# Root-owned resources are explicit inputs to the nested Cargo package.
native.export_file(
    name = "message",
    src = "fixtures/message.txt",
    visibility = ["PUBLIC"],
)
native.export_file(
    name = "ancestor-script",
    src = "ancestor-script.sh",
    visibility = ["PUBLIC"],
)

# Inventory must accept a real generated single-file artifact without a digest.
generated_resource(
    name = "generated-resource",
    visibility = ["PUBLIC"],
)
`

export default createGenieOutput({
  data: content,
  stringify: () => content,
})
