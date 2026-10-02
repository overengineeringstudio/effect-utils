//! `#[effect_rust::contract]`: idiomatic serde/schemars contracts with explicit wire semantics.
use crate::error::{rename_variant, Serde};
use proc_macro2::{Span, TokenStream};
use quote::{format_ident, quote, ToTokens};
use syn::{parse::Parser, punctuated::Punctuated, Attribute, Fields, Item, ItemEnum, ItemStruct, Lit, Meta, Token, Type};

#[derive(Default)]
struct Options {
    excess: Option<String>,
    pattern: Option<String>,
    flags: Option<String>,
    min_length: Option<u64>,
    max_length: Option<u64>,
}

impl Options {
    fn parse(tokens: TokenStream) -> syn::Result<Self> {
        let mut options = Self::default();
        for meta in Punctuated::<Meta, Token![,]>::parse_terminated.parse2(tokens)? {
            let Meta::NameValue(value) = &meta else { return Err(syn::Error::new_spanned(meta, "contract options are `key = literal`")) };
            let syn::Expr::Lit(literal) = &value.value else { return Err(syn::Error::new_spanned(value, "contract options require literals")) };
            let key = value.path.to_token_stream().to_string();
            match (key.as_str(), &literal.lit) {
                ("excess", Lit::Str(text)) if matches!(text.value().as_str(), "error" | "ignore") => options.excess = Some(text.value()),
                ("pattern", Lit::Str(text)) => options.pattern = Some(text.value()),
                ("flags", Lit::Str(text)) if matches!(text.value().as_str(), "u" | "iu") => options.flags = Some(text.value()),
                ("min_length", Lit::Int(number)) => options.min_length = Some(number.base10_parse()?),
                ("max_length", Lit::Int(number)) => options.max_length = Some(number.base10_parse()?),
                _ => return Err(syn::Error::new_spanned(value, "unknown contract option: use excess = \"error\"|\"ignore\", or pattern/flags = \"u\"|\"iu\"/min_length/max_length on a string brand")),
            }
        }
        Ok(options)
    }
    fn is_brand(&self) -> bool {
        self.pattern.is_some() || self.flags.is_some() || self.min_length.is_some() || self.max_length.is_some()
    }
}

pub(super) fn expand(args: TokenStream, item: TokenStream) -> syn::Result<TokenStream> {
    let options = Options::parse(args)?;
    match syn::parse2::<Item>(item)? {
        Item::Struct(item) if matches!(item.fields, Fields::Unnamed(_)) => brand(&options, item),
        Item::Struct(item) => {
            if options.is_brand() { return Err(syn::Error::new_spanned(&item.ident, "pattern/length options apply to a string brand `struct Name(String);`")); }
            structure(&options, item)
        }
        Item::Enum(item) => {
            if options.is_brand() { return Err(syn::Error::new_spanned(&item.ident, "pattern/length options apply to a string brand `struct Name(String);`")); }
            tagged_enum(&options, item)
        }
        other => Err(syn::Error::new_spanned(other, "contracts are named-field structs, internally tagged enums, or string brands")),
    }
}

/// Container attributes shared by structs and enums: strict excess by default,
/// schemars resolved through effect-rust, and the vocabulary's excess keyword.
fn container(options: &Options, attrs: &mut Vec<Attribute>) -> syn::Result<bool> {
    let derives_schema = attrs.iter().filter(|attr| attr.path().is_ident("derive")).any(|attr| {
        attr.parse_args_with(Punctuated::<syn::Path, Token![,]>::parse_terminated)
            .is_ok_and(|paths| paths.iter().any(|path| path.segments.last().is_some_and(|segment| segment.ident == "JsonSchema")))
    });
    if !derives_schema {
        return Err(syn::Error::new(Span::call_site(), "contracts derive serde and effect_rust::contract::JsonSchema below #[effect_rust::contract]"));
    }
    let serde = Serde::parse(attrs)?;
    let deny = options.excess.as_deref() != Some("ignore");
    if !deny && serde.deny_unknown_fields {
        return Err(syn::Error::new(Span::call_site(), "excess = \"ignore\" conflicts with #[serde(deny_unknown_fields)]"));
    }
    if deny && !serde.deny_unknown_fields { attrs.push(syn::parse_quote!(#[serde(deny_unknown_fields)])); }
    let transform: syn::Path = if deny { syn::parse_quote!(::effect_rust::contract::excess::error) } else { syn::parse_quote!(::effect_rust::contract::excess::ignore) };
    attrs.push(syn::parse_quote!(#[schemars(crate = "::effect_rust::contract::schemars", transform = #transform)]));
    Ok(deny)
}

fn structure(options: &Options, mut item: ItemStruct) -> syn::Result<TokenStream> {
    if !item.generics.params.is_empty() { return Err(syn::Error::new_spanned(&item.generics, "contracts require concrete types")); }
    container(options, &mut item.attrs)?;
    if let Fields::Named(fields) = &mut item.fields {
        for field in &mut fields.named { wire_field(field)?; }
    }
    Ok(item.into_token_stream())
}

/// Rewrites `#[wire(...)]` into serde and schemars attributes and rejects
/// numeric fields whose wire width would otherwise be lossy or implicit.
fn wire_field(field: &mut syn::Field) -> syn::Result<()> {
    let mut wire = None;
    let mut rest = Vec::new();
    for attr in field.attrs.drain(..) {
        if attr.path().is_ident("wire") {
            if wire.is_some() { return Err(syn::Error::new_spanned(attr, "duplicate #[wire] attribute")); }
            wire = Some((attr.parse_args::<syn::Ident>()?, attr));
        } else {
            rest.push(attr);
        }
    }
    field.attrs = rest;
    let name = type_name(&field.ty);
    match wire {
        Some((kind, attr)) => {
            let (serde_with, schema_with, accepted) = match kind.to_string().as_str() {
                "u64" => ("::effect_rust::wire::u64_decimal", "::effect_rust::contract::U64", name == "u64"),
                "i64" => ("::effect_rust::wire::i64_decimal", "::effect_rust::contract::I64", name == "i64"),
                "timestamp_millis" => ("::effect_rust::wire::timestamp_millis", "::effect_rust::TimestampMillis", name == "DateTime"),
                _ => return Err(syn::Error::new_spanned(attr, "unknown wire codec: use #[wire(u64)], #[wire(i64)] or #[wire(timestamp_millis)]")),
            };
            if !accepted {
                return Err(syn::Error::new_spanned(&field.ty, format!("#[wire({kind})] applies to a field of type {}", if kind == "timestamp_millis" { "chrono::DateTime<Utc>" } else { "matching integer width" })));
            }
            field.attrs.push(syn::parse_quote!(#[serde(with = #serde_with)]));
            field.attrs.push(syn::parse_quote!(#[schemars(with = #schema_with)]));
        }
        None => {
            if let Some(found) = lossy(&field.ty) {
                let remedy = match found.as_str() {
                    "u64" | "i64" => format!("add #[wire({found})] (canonical base-10 string) to a direct `{found}` field"),
                    "f32" | "f64" => "floats are not portable contract values; use an integer width or a decimal string brand".to_owned(),
                    _ => "use an explicit width: u8/u16/u32/i32 or #[wire(u64)]/#[wire(i64)]".to_owned(),
                };
                return Err(syn::Error::new_spanned(&field.ty, format!("`{found}` has no portable wire width: {remedy}")));
            }
            let defaulted = Serde::parse(&field.attrs)?.default;
            if name == "Patch" && !defaulted {
                field.attrs.push(syn::parse_quote!(#[serde(default, skip_serializing_if = "::effect_rust::Patch::is_absent")]));
            }
            // Option is required-and-nullable: serde emits `null` for None, so the key
            // must be present on decode too. Absence is modelled with Patch.
            if name == "Option" && !defaulted {
                let ty = &field.ty;
                let schema_with = quote!(::effect_rust::contract::Required<#ty>).to_string();
                field.attrs.push(syn::parse_quote!(#[serde(deserialize_with = "::effect_rust::wire::required")]));
                field.attrs.push(syn::parse_quote!(#[schemars(with = #schema_with)]));
            }
        }
    }
    Ok(())
}

fn lossy(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(path) => path.path.segments.iter().find_map(|segment| {
            let ident = segment.ident.to_string();
            if matches!(ident.as_str(), "u64" | "i64" | "u128" | "i128" | "usize" | "isize" | "f32" | "f64") { return Some(ident); }
            let syn::PathArguments::AngleBracketed(args) = &segment.arguments else { return None };
            args.args.iter().find_map(|arg| if let syn::GenericArgument::Type(ty) = arg { lossy(ty) } else { None })
        }),
        Type::Array(array) => lossy(&array.elem),
        Type::Slice(slice) => lossy(&slice.elem),
        Type::Reference(reference) => lossy(&reference.elem),
        Type::Tuple(tuple) => tuple.elems.iter().find_map(lossy),
        Type::Paren(paren) => lossy(&paren.elem),
        Type::Group(group) => lossy(&group.elem),
        _ => None,
    }
}

fn type_name(ty: &Type) -> String {
    match ty { Type::Path(path) => path.path.segments.last().map(|segment| segment.ident.to_string()).unwrap_or_default(), _ => String::new() }
}

/// Internally tagged enums keep serde's `Serialize` (tag first) and replace the
/// derived `Deserialize` with the streaming `effect_rust::tagged` decoder.
fn tagged_enum(options: &Options, mut item: ItemEnum) -> syn::Result<TokenStream> {
    if !item.generics.params.is_empty() { return Err(syn::Error::new_spanned(&item.generics, "contracts require concrete types")); }
    let serde = Serde::parse(&item.attrs)?;
    let Some(tag) = serde.tag.clone() else {
        return Err(syn::Error::new_spanned(&item.ident, "contract enums are internally tagged: add #[serde(tag = \"kind\")]"));
    };
    if serde.untagged || serde.content.is_some() {
        return Err(syn::Error::new_spanned(&item.ident, "contract enums are internally tagged: remove untagged/content"));
    }
    let deny = container(options, &mut item.attrs)?;
    let deserialize = take_derive(&mut item.attrs, "Deserialize");
    let name = &item.ident;
    let mut tags = Vec::new();
    let mut payloads = Vec::new();
    let mut arms = Vec::new();
    for (index, variant) in item.variants.iter_mut().enumerate() {
        let metadata = Serde::parse(&variant.attrs)?;
        if metadata.skip { return Err(syn::Error::new_spanned(&variant.ident, "skipped variants are not part of a contract; remove the variant")); }
        tags.push(metadata.rename.clone().unwrap_or_else(|| rename_variant(&variant.ident.to_string(), serde.rename_all.as_deref())));
        let payload = format_ident!("__{}Payload", variant.ident);
        let ident = &variant.ident;
        let rename_all = metadata.rename_all.as_deref().or(serde.rename_all_fields.as_deref()).map(|rule| quote!(rename_all = #rule,));
        let deny_attr = deny.then(|| quote!(deny_unknown_fields,));
        let fields = match &mut variant.fields {
            Fields::Unit => {
                arms.push(quote!(#index => { <#payload as ::serde::Deserialize>::deserialize(payload)?; Ok(Self::#ident) }));
                Vec::new()
            }
            Fields::Named(named) => {
                let mut fields = Vec::new();
                let mut moves = Vec::new();
                for field in &mut named.named {
                    wire_field(field)?;
                    let field_ident = field.ident.as_ref().expect("named field");
                    let ty = &field.ty;
                    let serde_attrs = field.attrs.iter().filter(|attr| attr.path().is_ident("serde"));
                    fields.push(quote!(#(#serde_attrs)* #field_ident: #ty));
                    moves.push(quote!(#field_ident: payload.#field_ident));
                }
                arms.push(quote!(#index => { let payload = <#payload as ::serde::Deserialize>::deserialize(payload)?; Ok(Self::#ident { #(#moves),* }) }));
                fields
            }
            Fields::Unnamed(_) => return Err(syn::Error::new_spanned(&variant.ident, "contract enum variants are unit or named-field variants")),
        };
        payloads.push(quote! {
            #[derive(::serde::Deserialize)]
            #[serde(#deny_attr #rename_all)]
            struct #payload { #(#fields),* }
        });
    }
    let decoder = deserialize.then(|| {
        let union = name.to_string();
        quote! {
            const _: () = {
                #(#payloads)*
                impl ::effect_rust::tagged::TaggedUnion for #name {
                    const NAME: &'static str = #union;
                    const TAG_FIELD: &'static str = #tag;
                    const TAGS: &'static [&'static str] = &[#(#tags),*];
                    fn deserialize_variant<'de, D: ::serde::Deserializer<'de>>(index: usize, payload: D) -> ::core::result::Result<Self, D::Error> {
                        match index {
                            #(#arms)*
                            _ => ::core::unreachable!("tagged decoder yields indices of TAGS only"),
                        }
                    }
                }
                impl<'de> ::serde::Deserialize<'de> for #name {
                    fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> ::core::result::Result<Self, D::Error> {
                        ::effect_rust::tagged::deserialize(deserializer)
                    }
                }
            };
        }
    });
    Ok(quote!(#item #decoder))
}

/// Removes `name` from `#[derive(...)]` lists; reports whether it was present.
fn take_derive(attrs: &mut Vec<Attribute>, name: &str) -> bool {
    let mut found = false;
    attrs.retain_mut(|attr| {
        if !attr.path().is_ident("derive") { return true; }
        let Ok(paths) = attr.parse_args_with(Punctuated::<syn::Path, Token![,]>::parse_terminated) else { return true };
        let kept: Punctuated<syn::Path, Token![,]> = paths.into_iter().filter(|path| {
            let matches = path.segments.last().is_some_and(|segment| segment.ident == name);
            found |= matches;
            !matches
        }).collect();
        if kept.is_empty() { return false; }
        *attr = syn::parse_quote!(#[derive(#kept)]);
        true
    });
    found
}

/// A validating string newtype: private field, `new`/`TryFrom`/`FromStr`, serde
/// through validation, and a named schema carrying the portable pattern.
fn brand(options: &Options, item: ItemStruct) -> syn::Result<TokenStream> {
    if options.excess.is_some() { return Err(syn::Error::new_spanned(&item.ident, "excess applies to object contracts, not string brands")); }
    if !item.generics.params.is_empty() { return Err(syn::Error::new_spanned(&item.generics, "contracts require concrete types")); }
    let Fields::Unnamed(fields) = &item.fields else { unreachable!("brand dispatch checks tuple fields") };
    let field = match fields.unnamed.iter().collect::<Vec<_>>().as_slice() {
        [field] if type_name(&field.ty) == "String" => *field,
        _ => return Err(syn::Error::new_spanned(&item.fields, "string brands wrap exactly one String: `struct Name(String);`")),
    };
    if !matches!(field.vis, syn::Visibility::Inherited) {
        return Err(syn::Error::new_spanned(&field.vis, "brand fields stay private so every value is validated"));
    }
    for attr in item.attrs.iter().filter(|attr| attr.path().is_ident("derive")) {
        let derives = attr.parse_args_with(Punctuated::<syn::Path, Token![,]>::parse_terminated)?;
        if derives.iter().any(|path| path.segments.last().is_some_and(|segment| ["Serialize", "Deserialize", "JsonSchema"].iter().any(|name| segment.ident == name))) {
            return Err(syn::Error::new_spanned(attr, "string brands generate their own serde and schema impls; remove those derives"));
        }
    }
    if !options.is_brand() {
        return Err(syn::Error::new_spanned(&item.ident, "string brands declare pattern, min_length or max_length"));
    }
    let name = &item.ident;
    let label = name.to_string();
    let flags = options.flags.clone().unwrap_or_else(|| "u".into());
    let mut checks = Vec::new();
    let mut schema = vec![quote!("type": "string")];
    if let (Some(minimum), Some(maximum)) = (options.min_length, options.max_length) {
        if minimum > maximum { return Err(syn::Error::new(Span::call_site(), "min_length exceeds max_length")); }
    }
    if options.min_length.unwrap_or(0) > 0 || options.max_length.is_some() {
        // Count code points only as far as the bounds require.
        let limit = options.max_length.map_or_else(|| options.min_length.unwrap_or(0), |maximum| maximum + 1);
        let limit = usize::try_from(limit).map_err(|_| syn::Error::new(Span::call_site(), "length bound exceeds usize"))?;
        checks.push(quote!(let length = value.chars().take(#limit).count();));
        if let Some(minimum) = options.min_length.filter(|minimum| *minimum > 0) {
            let minimum = usize::try_from(minimum).map_err(|_| syn::Error::new(Span::call_site(), "length bound exceeds usize"))?;
            checks.push(quote!(if length < #minimum { return Err(::effect_rust::ValidationError::new(#label, concat!("string shorter than ", #minimum, " code points"))); }));
            schema.push(quote!("minLength": #minimum));
        }
        if let Some(maximum) = options.max_length {
            let maximum = usize::try_from(maximum).map_err(|_| syn::Error::new(Span::call_site(), "length bound exceeds usize"))?;
            checks.push(quote!(if length > #maximum { return Err(::effect_rust::ValidationError::new(#label, concat!("string longer than ", #maximum, " code points"))); }));
            schema.push(quote!("maxLength": #maximum));
        }
    } else if let Some(minimum) = options.min_length {
        // min_length = 0 is an explicit, vacuous bound; keep it visible in the schema.
        let minimum = usize::try_from(minimum).map_err(|_| syn::Error::new(Span::call_site(), "length bound exceeds usize"))?;
        schema.push(quote!("minLength": #minimum));
    }
    if let Some(pattern) = &options.pattern {
        let rust = rust_pattern(pattern, &flags)?;
        let message = format!("string must match {pattern}");
        checks.push(quote! {
            static PATTERN: ::effect_rust::contract::__private::LazyLock<::effect_rust::contract::__private::Regex> =
                ::effect_rust::contract::__private::LazyLock::new(|| ::effect_rust::contract::__private::Regex::new(#rust).expect("pattern validated at macro expansion"));
            if !PATTERN.is_match(&value) { return Err(::effect_rust::ValidationError::new(#label, #message)); }
        });
        schema.push(quote!("pattern": #pattern));
        schema.push(quote!("x-effect-rust-pattern": #pattern));
        schema.push(quote!("x-effect-rust-pattern-flags": #flags));
    } else if options.flags.is_some() {
        return Err(syn::Error::new_spanned(&item.ident, "flags require a pattern"));
    }
    let attrs = &item.attrs;
    let vis = &item.vis;
    Ok(quote! {
        #(#attrs)*
        #vis struct #name(String);
        impl #name {
            /// # Errors
            /// Rejects values outside the contract's pattern or code-point bounds.
            pub fn new(value: impl Into<String>) -> ::core::result::Result<Self, ::effect_rust::ValidationError> {
                let value = value.into();
                #(#checks)*
                Ok(Self(value))
            }
            #[must_use]
            pub fn as_str(&self) -> &str { &self.0 }
            #[must_use]
            pub fn into_inner(self) -> String { self.0 }
        }
        impl ::core::convert::TryFrom<String> for #name {
            type Error = ::effect_rust::ValidationError;
            fn try_from(value: String) -> ::core::result::Result<Self, Self::Error> { Self::new(value) }
        }
        impl ::core::convert::TryFrom<&str> for #name {
            type Error = ::effect_rust::ValidationError;
            fn try_from(value: &str) -> ::core::result::Result<Self, Self::Error> { Self::new(value) }
        }
        impl ::core::str::FromStr for #name {
            type Err = ::effect_rust::ValidationError;
            fn from_str(value: &str) -> ::core::result::Result<Self, Self::Err> { Self::new(value) }
        }
        impl ::core::convert::AsRef<str> for #name {
            fn as_ref(&self) -> &str { &self.0 }
        }
        impl ::core::fmt::Display for #name {
            fn fmt(&self, formatter: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result { formatter.write_str(&self.0) }
        }
        impl ::serde::Serialize for #name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> ::core::result::Result<S::Ok, S::Error> { serializer.serialize_str(&self.0) }
        }
        impl<'de> ::serde::Deserialize<'de> for #name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> ::core::result::Result<Self, D::Error> {
                let value = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                Self::new(value).map_err(::serde::de::Error::custom)
            }
        }
        impl ::effect_rust::contract::schemars::JsonSchema for #name {
            fn schema_name() -> ::std::borrow::Cow<'static, str> { #label.into() }
            fn schema_id() -> ::std::borrow::Cow<'static, str> { concat!(module_path!(), "::", #label).into() }
            fn json_schema(_: &mut ::effect_rust::contract::schemars::SchemaGenerator) -> ::effect_rust::contract::schemars::Schema {
                ::effect_rust::contract::schemars::json_schema!({ #(#schema),* })
            }
        }
    })
}

/// The Rust spelling of a portable pattern, validated at expansion time.
/// Full-string anchors are mandatory; `$` becomes `\z` because Rust's `$`
/// and JavaScript's differ around a trailing newline.
fn rust_pattern(pattern: &str, flags: &str) -> syn::Result<String> {
    if !pattern.starts_with('^') || !pattern.ends_with('$') || pattern.ends_with("\\$") {
        return Err(syn::Error::new(Span::call_site(), "portable patterns are full-string anchored: ^...$"));
    }
    let rust = format!("{}{}\\z", if flags == "iu" { "(?i)" } else { "" }, &pattern[..pattern.len() - 1]);
    regex_syntax::Parser::new().parse(&rust).map_err(|error| syn::Error::new(Span::call_site(), format!("invalid pattern: {error}")))?;
    Ok(rust)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand_error(args: TokenStream, item: TokenStream) -> String {
        expand(args, item).expect_err("expected rejection").to_string()
    }

    #[test]
    fn rejects_implicit_wide_and_float_widths() {
        let error = |fields: TokenStream| expand_error(quote!(), quote!(#[derive(Serialize, JsonSchema)] struct Order { #fields }));
        assert!(error(quote!(id: u64)).contains("#[wire(u64)]"));
        assert!(error(quote!(ids: Vec<i64>)).contains("i64"));
        assert!(error(quote!(size: usize)).contains("usize"));
        assert!(error(quote!(ratio: Option<f64>)).contains("floats"));
        assert!(error(quote!(#[wire(u64)] id: u32)).contains("matching integer width"));
        assert!(expand_error(quote!(), quote!(#[derive(Serialize)] struct Order { id: u32 })).contains("JsonSchema"));
    }

    #[test]
    fn rejects_untagged_enums_and_unanchored_brands() {
        assert!(expand_error(quote!(), quote!(enum Shape { A })).contains("internally tagged"));
        assert!(expand_error(quote!(), quote!(#[serde(tag = "kind", content = "value")] enum Shape { A })).contains("internally tagged"));
        assert!(expand_error(quote!(pattern = "[a-z]+"), quote!(struct Name(String);)).contains("anchored"));
        assert!(expand_error(quote!(pattern = "^(a$"), quote!(struct Name(String);)).contains("invalid pattern"));
        assert!(expand_error(quote!(pattern = "^a$"), quote!(struct Name(pub String);)).contains("private"));
    }
}
