use proc_macro2::{Span, TokenStream};
use quote::{format_ident, quote};
use syn::{Attribute, Data, DeriveInput, Fields, LitStr};

pub(super) fn expand(input: DeriveInput) -> syn::Result<TokenStream> {
    if !input.generics.params.is_empty() { return Err(syn::Error::new_spanned(&input.generics,"error contracts require a concrete enum")); }
    let Data::Enum(data) = &input.data else { return Err(syn::Error::new_spanned(&input.ident,"ExportError requires an enum")); };
    let container=Serde::parse(&input.attrs)?;
    let tag=container.tag.as_deref().ok_or_else(||syn::Error::new_spanned(&input.ident,"ExportError requires #[serde(tag = \"kind\")] (or another explicit tag key)"))?;
    if container.untagged || container.content.is_some() { return Err(syn::Error::new_spanned(&input.ident,"ExportError requires an internally tagged enum")); }
    let mut variants=Vec::new();
    for variant in &data.variants {
        let metadata=Serde::parse(&variant.attrs)?;
        if metadata.skip { continue; }
        let name=metadata.rename.clone().unwrap_or_else(||rename_variant(&variant.ident.to_string(),container.rename_all.as_deref()));
        let mut fields=Vec::new();
        match &variant.fields {
            Fields::Unit=>{},
            Fields::Named(named)=>for field in &named.named {
                let field_metadata=Serde::parse(&field.attrs)?;
                if field_metadata.flatten { return Err(syn::Error::new_spanned(field,"flattened error fields need a named struct contract instead")); }
                if field_metadata.skip {continue;}
                let ident=field.ident.as_ref().expect("named field");
                let field_name=field_metadata.rename.unwrap_or_else(||rename_field(ident.to_string().trim_start_matches("r#"),metadata.rename_all.as_deref().or(container.rename_all_fields.as_deref())));
                fields.push(serde_json::json!({"name":field_name,"type":super::wire_name(&field.ty)}));
            },
            Fields::Unnamed(_)=>return Err(syn::Error::new_spanned(variant,"error reasons require named fields or unit variants")),
        }
        variants.push(serde_json::json!({"name":name,"fields":fields}));
    }
    let name=&input.ident;
    let ident=format_ident!("__EFFECT_RUST_ERROR_{}",name);
    let manifest=serde_json::json!({"name":name.to_string(),"tagKey":tag,"variants":variants});
    let mut bytes=b"\0EFFECT_RUST_ERROR\0".to_vec();
    bytes.extend(serde_json::to_vec(&manifest).map_err(|error|syn::Error::new(Span::call_site(),error.to_string()))?);bytes.push(0);
    let len=bytes.len();let bytes=syn::LitByteStr::new(&bytes,Span::call_site());
    Ok(quote!{
        impl effect_rust::ExportError for #name {
            const TAG_KEY: &'static str = #tag;
        }
        #[doc(hidden)] #[used]
        #[cfg_attr(target_arch="wasm32",link_section="effect-rust.errors")]
        #[allow(non_upper_case_globals)]
        #[cfg_attr(not(target_arch="wasm32"),export_name=concat!("__effect_rust_error_",env!("CARGO_PKG_NAME"),"_",stringify!(#name)))]
        pub static #ident:[u8;#len]=*#bytes;
    })
}
/// Subset of serde attributes that shape the wire contract.
#[derive(Default)]
pub(super) struct Serde {
    pub(super) tag:Option<String>,pub(super) rename:Option<String>,pub(super) rename_all:Option<String>,pub(super) rename_all_fields:Option<String>,pub(super) content:Option<String>,
    pub(super) untagged:bool,pub(super) skip:bool,pub(super) flatten:bool,pub(super) default:bool,pub(super) deny_unknown_fields:bool,
}
impl Serde {
    pub(super) fn parse(attrs:&[Attribute])->syn::Result<Self>{
        let mut result=Self::default();
        for attr in attrs.iter().filter(|attr|attr.path().is_ident("serde")) {
            attr.parse_nested_meta(|meta|{
                let field=if meta.path.is_ident("tag"){Some(&mut result.tag)}else if meta.path.is_ident("rename"){Some(&mut result.rename)}else if meta.path.is_ident("rename_all"){Some(&mut result.rename_all)}else if meta.path.is_ident("rename_all_fields"){Some(&mut result.rename_all_fields)}else if meta.path.is_ident("content"){Some(&mut result.content)}else{None};
                if let Some(field)=field{*field=Some(meta.value()?.parse::<LitStr>()?.value());}
                else if meta.path.is_ident("untagged"){result.untagged=true;}
                else if meta.path.is_ident("skip")||meta.path.is_ident("skip_serializing"){result.skip=true;}
                else if meta.path.is_ident("flatten"){result.flatten=true;}
                else if meta.path.is_ident("deny_unknown_fields"){result.deny_unknown_fields=true;}
                else if meta.path.is_ident("default"){result.default=true;if meta.input.peek(syn::Token![=]){let _:syn::Expr=meta.value()?.parse()?;}}
                else if meta.input.peek(syn::Token![=]){let _:syn::Expr=meta.value()?.parse()?;}
                else if meta.input.peek(syn::token::Paren){meta.parse_nested_meta(|nested|{if nested.input.peek(syn::Token![=]){let _:syn::Expr=nested.value()?.parse()?;}Ok(())})?;}
                Ok(())
            })?;
        }
        Ok(result)
    }
}
// Serde deliberately applies different case rules to PascalCase variants and
// snake_case fields. In particular, acronym letters remain separate in variants.
pub(super) fn rename_variant(name: &str, rule: Option<&str>) -> String {
    match rule {
        Some("lowercase") => name.to_ascii_lowercase(),
        Some("UPPERCASE") => name.to_ascii_uppercase(),
        Some("camelCase") => lowercase_first(name),
        Some("snake_case" | "SCREAMING_SNAKE_CASE" | "kebab-case" | "SCREAMING-KEBAB-CASE") => {
            let mut snake = String::new();
            for (index, ch) in name.char_indices() {
                if index > 0 && ch.is_uppercase() { snake.push('_'); }
                snake.push(ch.to_ascii_lowercase());
            }
            if matches!(rule, Some("SCREAMING_SNAKE_CASE" | "SCREAMING-KEBAB-CASE")) { snake.make_ascii_uppercase(); }
            if matches!(rule, Some("kebab-case" | "SCREAMING-KEBAB-CASE")) { snake = snake.replace('_', "-"); }
            snake
        }
        _ => name.to_owned(),
    }
}
fn rename_field(name: &str, rule: Option<&str>) -> String {
    match rule {
        Some("UPPERCASE" | "SCREAMING_SNAKE_CASE") => name.to_ascii_uppercase(),
        Some("kebab-case") => name.replace('_', "-"),
        Some("SCREAMING-KEBAB-CASE") => name.to_ascii_uppercase().replace('_', "-"),
        Some("PascalCase" | "camelCase") => {
            let mut pascal = String::new();
            let mut capitalize = true;
            for ch in name.chars() {
                if ch == '_' { capitalize = true; }
                else {
                    pascal.push(if capitalize { ch.to_ascii_uppercase() } else { ch });
                    capitalize = false;
                }
            }
            if rule == Some("camelCase") { lowercase_first(&pascal) } else { pascal }
        }
        _ => name.to_owned(),
    }
}
fn lowercase_first(name: &str) -> String {
    let mut chars = name.chars();
    chars.next().map_or_else(String::new, |first| first.to_ascii_lowercase().to_string() + chars.as_str())
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn rejects_lossy_untagged_and_tuple_errors(){
        assert!(expand(syn::parse_quote!(#[serde(untagged)]enum E{A})).is_err());
        assert!(expand(syn::parse_quote!(#[serde(tag="kind")]enum E{A(u32)})).is_err());
    }
    #[test]
    fn serde_case_rules_preserve_reason_names(){
        assert_eq!(rename_variant("InvalidURL",Some("snake_case")),"invalid_u_r_l");
        assert_eq!(rename_variant("DivisionByZero",Some("camelCase")),"divisionByZero");
        assert_eq!(rename_field("io_error",Some("SCREAMING-KEBAB-CASE")),"IO-ERROR");
        assert_eq!(rename_field("http_url",Some("camelCase")),"httpUrl");
    }
}
