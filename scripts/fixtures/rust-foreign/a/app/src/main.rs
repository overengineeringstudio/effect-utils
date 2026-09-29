fn main() {
    let rendered = foreign_shared::render(42);
    assert_eq!(memchr::memchr(b'2', rendered.as_bytes()), Some(1));
    println!("{rendered}");
}
