fn main() {
    let mut buffer = renamed_itoa::Buffer::new();
    let rendered = foreign_shared::render(&mut buffer, 42);
    assert_eq!(memchr::memchr(b'2', rendered.as_bytes()), Some(1));
    println!("{rendered}");
}
