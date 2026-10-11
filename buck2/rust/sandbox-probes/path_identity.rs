const MANIFEST: &str = env!(concat!("CARGO_", "MANIFEST_DIR"));
const TMP: &str = env!("TMPDIR");
const INCLUDED: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/included.txt"));
const MACRO_READ: &str = reader::read_declared!();
const COMPILER_VIEW: &str = reader::compiler_view!();

fn main() {
    println!("manifest={MANIFEST}\ntmp={TMP}\ninput={INCLUDED}\nmacro={MACRO_READ}\n{COMPILER_VIEW}");
}
