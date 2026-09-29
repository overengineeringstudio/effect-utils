pub fn render(value: u64) -> String {
    itoa::Buffer::new().format(value).to_owned()
}
