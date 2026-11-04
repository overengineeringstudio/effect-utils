extern crate proc_macro;
use proc_macro::{TokenStream, TokenTree};

#[proc_macro_derive(Probe)]
pub fn derive_probe(input: TokenStream) -> TokenStream {
    let mut tokens = input.into_iter();
    while let Some(token) = tokens.next() {
        if matches!(token, TokenTree::Ident(ref ident) if ident.to_string() == "struct") {
            let Some(TokenTree::Ident(name)) = tokens.next() else {
                panic!("Probe requires a named struct");
            };
            return format!("impl {name} {{ pub fn probe() -> u32 {{ 42 }} }}")
                .parse()
                .expect("valid generated impl");
        }
    }
    panic!("Probe requires a struct");
}
