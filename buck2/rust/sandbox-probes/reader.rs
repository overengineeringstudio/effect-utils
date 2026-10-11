extern crate proc_macro;

#[proc_macro]
pub fn read_declared(_: proc_macro::TokenStream) -> proc_macro::TokenStream {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("manifest path is declared");
    let value = std::fs::read_to_string(std::path::Path::new(&manifest).join("included.txt"))
        .expect("proc macro can read its declared consumer input");
    format!("{value:?}").parse().expect("quoted Rust literal")
}

#[proc_macro]
pub fn compiler_view(_: proc_macro::TokenStream) -> proc_macro::TokenStream {
    let mut environment: Vec<_> = std::env::vars().collect();
    environment.sort();
    let arguments: Vec<_> = std::env::args().collect();
    let response_path = arguments
        .iter()
        .find_map(|arg| arg.strip_prefix('@'))
        .expect("compiler uses its response file");
    let response = std::fs::read_to_string(response_path).expect("compiler response is readable");
    let view = format!("env={environment:?}\nargv={arguments:?}\nresponse={response}");
    format!("{view:?}").parse().expect("quoted compiler view")
}
