// The consumer must supply its own third-party instance, not the provider's graph.
pub fn render(buffer: &mut itoa::Buffer, value: u64) -> &str {
    buffer.format(value)
}

// Fresh-root cache proof compares this rlib's bytes to check compiler path remapping.
pub const SOURCE_PATH: &str = file!();
