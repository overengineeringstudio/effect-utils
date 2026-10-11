const MANIFEST: &str = env!(concat!("CARGO_", "MANIFEST_DIR"));
const TMP: &str = env!("TMPDIR");
const INCLUDED: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/included.txt"));

fn main() {
    println!("manifest={MANIFEST}\ntmp={TMP}\ninput={INCLUDED}");
}
