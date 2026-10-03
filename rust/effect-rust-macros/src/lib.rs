//! Edge adapters for plain Rust exports. Backend code is target-gated; the original
//! function remains available to Rust callers in every feature configuration.
//!
//! Adapter crates declare `wasm` and `napi` features and supply their backend
//! dependencies directly. Glue is selected by both feature and target, so a
//! unified Cargo feature graph can enable both without mixing JS runtimes.
//! Native adapters require panic unwinding. Normal Rust builds have no JS types.
//!
//! Domain types cross the edge through serde. Wide fields inside domain types
//! must opt into the runtime's decimal serde field helpers; only primitive
//! wide parameters/returns are converted automatically from their Rust types.
#![forbid(unsafe_code)]

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as Tokens};
use quote::{format_ident, quote, ToTokens};
use syn::{parse::Parser, punctuated::Punctuated, FnArg, GenericArgument, ItemFn, Lit, Meta, Pat, PathArguments, ReturnType, Token, Type};

mod backend;
mod contract;
mod error;
mod resource;

/// Makes a serde type a Rust-owned wire contract (requires effect-rust's `contract` feature).
///
/// Structs and internally tagged enums keep their serde/schemars derives; the
/// attribute adds strict excess handling (`#[serde(deny_unknown_fields)]` unless
/// `excess = "ignore"`), resolves schemars through effect-rust, and emits the
/// `x-effect-rust-*` vocabulary. Field attributes:
///
/// - `#[wire(u64)]` / `#[wire(i64)]`: canonical base-10 strings. Bare 64-bit,
///   pointer-sized and float fields are rejected because their width is not portable.
/// - `#[wire(timestamp_millis)]` on `chrono::DateTime<Utc>`: RFC 3339 milliseconds.
/// - `effect_rust::Patch<T>` fields become omittable (`Absent`/`Null`/`Value`).
///
/// Enums replace the derived `Deserialize` with `effect_rust::tagged`: any key
/// order decodes, with a streaming fast path when the tag key comes first.
///
/// `#[effect_rust::contract(pattern = "^...$", flags = "u", min_length = 1, max_length = 63)]`
/// on `struct Name(String);` generates a validating string brand.
#[proc_macro_attribute]
pub fn contract(args: TokenStream, item: TokenStream) -> TokenStream {
    match contract::expand(args.into(), item.into()) {
        Ok(output) => output.into(),
        Err(error) => error.into_compile_error().into(),
    }
}

/// Embeds a tagged error enum's variant and named-field contracts in the binary.
///
/// Requires an internally tagged serde enum. Serde `tag`, `rename`,
/// `rename_all`, and `rename_all_fields` remain authoritative; unit and
/// named-field variants are supported. Tuple/untagged/flattened contracts are
/// rejected rather than generating a lossy TypeScript reason union.
/// Also implements `effect_rust::ExportError::TAG_KEY` from the same serde tag,
/// allowing exported expected errors to retain their own tag without repeating it.
#[proc_macro_derive(ExportError, attributes(serde))]
pub fn export_error(item: TokenStream) -> TokenStream {
    match syn::parse(item).and_then(error::expand) {
        Ok(output) => output.into(),
        Err(error) => error.into_compile_error().into(),
    }
}
/// Exports a plain Rust function with target-specific JS glue and binary metadata.
///
/// Modes are `sync` (default), `async`, `input_stream`, `output_stream`,
/// `borrowed`, and `frame`. `name = "jsName"` overrides the JS name;
/// Expected `Result` errors implement `effect_rust::ExportError` (normally via
/// the derive). Their serde tag is authoritative. An optional `error_tag = "kind"`
/// is a manifest assertion; packaging rejects a mismatch with derived metadata.
///
/// Input stream state must expose `update(&mut self, &[u8])` and `finish(self)`.
/// Its finish wire type is declared by `returns = "RustType"`; without that
/// metadata the result is an opaque serde JSON value. `finish` consumes state
/// exactly once. Output stream factories return a byte iterator, concrete or
/// `impl Iterator`; `next(maxBytes)` retains excess bytes until subsequent pulls.
/// Stream handles expose `close`; napi also exposes `free`, and wasm-bindgen
/// supplies its standard destructor `free`.
///
/// Borrowed exports accept synchronous `&[u8]`. Frame exports accept `&[Row]`,
/// require `contract_id` and `version`, and decode the mandatory Borsh header
/// through `effect_rust::frame::decode::<Vec<Row>>`.
///
/// Async exports return `{ _tag: "RustJob", mode, result: Promise, cancel }`.
/// Abortable cancellation drops Rust work before its acknowledgement resolves;
/// settle-only cancellation waits for Rust work to finish. A `host::Source`
/// argument is a callback taking `{ kind: "read", path }`,
/// `{ kind: "readRange", path, offset: "<canonical u64>", maxBytes }`, or
/// `{ kind: "yield" }`. It returns `Promise<Uint8Array>` (Buffer natively):
/// range responses must fit the bound and yield returns an empty acknowledgement
/// after an event-loop task. The service adapter owns JS cancellation/quiescence;
/// the raw job guarantees no subsequent Rust host calls after acknowledgement.
///
/// Expected errors are JS Errors with `RUST_ERROR:` plus tag-first JSON;
/// native panics become `RUST_PANIC:` defects. Each export embeds compact JSON
/// after `\\0EFFECT_RUST_EXPORT\\0`, terminated by NUL, in a wasm custom section
/// or a retained, exported native static. `ExportError` uses the analogous
/// `EFFECT_RUST_ERROR` sentinel for the error reason schema.
#[proc_macro_attribute]
pub fn export(args: TokenStream, item: TokenStream) -> TokenStream {
    match expand(args.into(), item.into()) {
        Ok(output) => output.into(),
        Err(error) => error.into_compile_error().into(),
    }
}

/// Exports an inherent resource impl with a public `new(...) -> Self` constructor.
/// Public synchronous `&self` / `&mut self` methods are serialized per resource by
/// the generated scoped Effect API. Async, consuming, generic and static methods
/// other than `new` are rejected. Native panics unwind; wasm traps retire the
/// entire instance without running Rust destructors through poisoned glue.
#[proc_macro_attribute]
pub fn resource(args: TokenStream, item: TokenStream) -> TokenStream {
    resource::expand(args.into(), item.into())
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode { Sync, Async, InputStream, OutputStream, Borrowed, Frame }
impl Mode {
    fn name(self) -> &'static str {
        match self { Self::Sync => "sync", Self::Async => "async", Self::InputStream => "input_stream", Self::OutputStream => "output_stream", Self::Borrowed => "borrowed", Self::Frame => "frame" }
    }
}

struct Options {
    mode: Mode,
    name: Option<String>,
    error_tag: String,
    error_tag_explicit: bool,
    returns: Option<Type>,
    contract_id: Option<u32>,
    version: Option<u16>,
}
impl Options {
    fn parse(tokens: Tokens) -> syn::Result<Self> {
        // `async` is a Rust keyword, whereas syn::Meta expects an ordinary path.
        let mut tokens = tokens.into_iter().collect::<Vec<_>>();
        for token in &mut tokens {
            if let proc_macro2::TokenTree::Ident(ident) = token {
                if ident == "async" { *ident = syn::Ident::new_raw("async", ident.span()); }
            }
        }
        let metas = Punctuated::<Meta, Token![,]>::parse_terminated.parse2(tokens.into_iter().collect())?;
        let mut options = Self { mode: Mode::Sync, name: None, error_tag: "kind".into(), error_tag_explicit: false, returns: None, contract_id: None, version: None };
        let mut seen = std::collections::HashSet::new();
        let mut mode_seen = false;
        for meta in metas {
            let key = meta.path().to_token_stream().to_string().trim_start_matches("r#").to_owned();
            if !seen.insert(key.clone()) { return Err(syn::Error::new_spanned(meta, "duplicate export option")); }
            match meta {
                Meta::Path(path) => {
                    options.mode = match key.as_str() {
                        "sync" => Mode::Sync, "async" => Mode::Async, "input_stream" => Mode::InputStream,
                        "output_stream" => Mode::OutputStream, "borrowed" => Mode::Borrowed, "frame" => Mode::Frame,
                        _ => return Err(syn::Error::new_spanned(path, "unknown export mode")),
                    };
                    if mode_seen { return Err(syn::Error::new_spanned(path, "choose exactly one export mode")); }
                    mode_seen = true;
                }
                Meta::NameValue(value) => {
                    let syn::Expr::Lit(expr) = &value.value else { return Err(syn::Error::new_spanned(value, "export options require literals")); };
                    match (key.as_str(), &expr.lit) {
                        ("name", Lit::Str(value)) => options.name = Some(value.value()),
                        ("error_tag", Lit::Str(value)) => { options.error_tag = value.value(); options.error_tag_explicit = true; },
                        ("returns", Lit::Str(value)) => options.returns = Some(syn::parse_str(&value.value())?),
                        ("contract_id", Lit::Int(value)) => options.contract_id = Some(value.base10_parse()?),
                        ("version", Lit::Int(value)) => options.version = Some(value.base10_parse()?),
                        _ => return Err(syn::Error::new_spanned(value, "unknown option or wrong literal type")),
                    }
                }
                Meta::List(value) => return Err(syn::Error::new_spanned(value, "nested export options are not supported")),
            }
        }
        if options.mode == Mode::Frame && (options.contract_id.is_none() || options.version.is_none()) {
            return Err(syn::Error::new(Span::call_site(), "frame exports require contract_id and version"));
        }
        if options.mode != Mode::Frame && (options.contract_id.is_some() || options.version.is_some()) {
            return Err(syn::Error::new(Span::call_site(), "contract_id and version apply only to frame exports"));
        }
        if options.mode != Mode::InputStream && options.returns.is_some() {
            return Err(syn::Error::new(Span::call_site(), "returns metadata applies only to input_stream finish"));
        }
        if options.name.as_deref() == Some("") || options.error_tag.is_empty() {
            return Err(syn::Error::new(Span::call_site(), "export names and error tag keys must not be empty"));
        }
        Ok(options)
    }
}

#[derive(Clone)]
enum Wire {
    Unit, Scalar(Type), Wide(Type), String, Bytes, BorrowedBytes, Frame(Type), Json(Type), Source(Type, bool),
}
impl Wire {
    fn classify(ty: &Type, mode: Mode) -> syn::Result<Self> {
        match ty {
            Type::Tuple(value) if value.elems.is_empty() => Ok(Self::Unit),
            Type::Reference(reference) => {
                if reference.mutability.is_some() { return Err(syn::Error::new_spanned(ty, "mutable references cannot cross the JS edge")); }
                if let Type::Slice(slice) = reference.elem.as_ref() {
                    if mode == Mode::Frame { return Ok(Self::Frame((*slice.elem).clone())); }
                    if type_name(&slice.elem) == "u8" && mode == Mode::Borrowed { return Ok(Self::BorrowedBytes); }
                }
                Err(syn::Error::new_spanned(ty, "references require borrowed &[u8] or frame &[Row]"))
            }
            Type::Path(path) => {
                let name = type_name(ty);
                match name.as_str() {
                    "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64" | "bool" => Ok(Self::Scalar(ty.clone())),
                    "u64" | "i64" | "u128" | "i128" => Ok(Self::Wide(ty.clone())),
                    "usize" | "isize" => Err(syn::Error::new_spanned(ty, "architecture-dependent integer width: use u32/u64 or i32/i64")),
                    "String" => Ok(Self::String),
                    "Bytes" => Ok(Self::Bytes),
                    "Vec" if generic_types(ty).first().is_some_and(|item| type_name(item) == "u8") => Ok(Self::Bytes),
                    "Source" => {
                        if mode != Mode::Async { return Err(syn::Error::new_spanned(path, "host::Source requires async export mode")); }
                        let settle = generic_types(ty).first().is_some_and(|item| type_name(item) == "SettleOnly");
                        Ok(Self::Source(ty.clone(), settle))
                    }
                    _ => Ok(Self::Json(ty.clone())),
                }
            }
            _ => Err(syn::Error::new_spanned(ty, "unsupported export type: use a concrete serde domain type")),
        }
    }
    fn name(&self) -> String {
        match self {
            Self::Unit => "void".into(), Self::Scalar(ty) | Self::Wide(ty) => type_name(ty),
            Self::String => "string".into(), Self::Bytes | Self::BorrowedBytes => "bytes".into(),
            Self::Frame(ty) => format!("frame<{}>", type_name(ty)),
            Self::Json(ty) => {
                let args = generic_types(ty);
                match type_name(ty).as_str() {
                    "Vec" if args.len() == 1 => format!("array<{}>", wire_name(args[0])),
                    "Option" if args.len() == 1 => format!("option<{}>", wire_name(args[0])),
                    _ => type_name(ty),
                }
            }
            Self::Source(_, settle) => format!("host::Source<{}>", if *settle { "SettleOnly" } else { "Abortable" }),
        }
    }
}
fn type_name(ty: &Type) -> String {
    match ty { Type::Path(path) => path.path.segments.last().map(|s| s.ident.to_string()).unwrap_or_default(), _ => ty.to_token_stream().to_string() }
}
fn generic_types(ty: &Type) -> Vec<&Type> {
    if let Type::Path(path) = ty {
        if let Some(segment) = path.path.segments.last() {
            if let PathArguments::AngleBracketed(arguments) = &segment.arguments {
                return arguments.args.iter().filter_map(|argument| if let GenericArgument::Type(ty) = argument { Some(ty) } else { None }).collect();
            }
        }
    }
    vec![]
}
fn wire_name(ty: &Type) -> String { Wire::classify(ty, Mode::Sync).map_or_else(|_| type_name(ty), |wire| wire.name()) }

struct Export {
    function: ItemFn,
    options: Options,
    args: Vec<(syn::Ident, Wire)>,
    success: Type,
    error: Option<Type>,
}
impl Export {
    fn parse(options: Options, function: ItemFn) -> syn::Result<Self> {
        if function.sig.constness.is_some() || function.sig.unsafety.is_some() || function.sig.abi.is_some() || !function.sig.generics.params.is_empty() || function.sig.variadic.is_some() {
            return Err(syn::Error::new_spanned(&function.sig, "exports require a safe, non-generic Rust function"));
        }
        if function.sig.asyncness.is_some() != (options.mode == Mode::Async) {
            return Err(syn::Error::new_spanned(&function.sig, "async fn requires #[export(async)]; other modes require synchronous fn"));
        }
        let mut args = Vec::new();
        for arg in &function.sig.inputs {
            let FnArg::Typed(arg) = arg else { return Err(syn::Error::new_spanned(arg, "exports must be free functions")); };
            let Pat::Ident(name) = arg.pat.as_ref() else { return Err(syn::Error::new_spanned(&arg.pat, "export arguments require named bindings")); };
            args.push((name.ident.clone(), Wire::classify(&arg.ty, options.mode)?));
        }
        if options.mode == Mode::Borrowed && !args.iter().any(|(_, wire)| matches!(wire, Wire::BorrowedBytes)) {
            return Err(syn::Error::new_spanned(&function.sig, "borrowed exports require a &[u8] argument"));
        }
        if options.mode == Mode::Frame && !args.iter().any(|(_, wire)| matches!(wire, Wire::Frame(_))) {
            return Err(syn::Error::new_spanned(&function.sig, "frame exports require a &[Row] argument"));
        }
        let returns = match &function.sig.output { ReturnType::Default => syn::parse_quote!(()), ReturnType::Type(_, ty) => *ty.clone() };
        let generic = generic_types(&returns);
        let (success, error) = if type_name(&returns) == "Result" && generic.len() == 2 { (generic[0].clone(), Some(generic[1].clone())) } else { (returns, None) };
        if options.mode == Mode::InputStream && !matches!(success, Type::Path(_)) {
            return Err(syn::Error::new_spanned(&success, "input_stream factory must return a concrete state type"));
        }
        if options.mode == Mode::OutputStream && !iterator_bytes(&success) {
            return Err(syn::Error::new_spanned(&success, "output_stream requires a byte iterator, concrete or impl Iterator<Item = Vec<u8>>"));
        }
        if !matches!(options.mode, Mode::InputStream | Mode::OutputStream) { Wire::classify(&success, Mode::Sync)?; }
        Ok(Self { function, options, args, success, error })
    }
    fn name(&self) -> String { self.options.name.clone().unwrap_or_else(|| self.function.sig.ident.to_string()) }
    /// Serde domain positions whose schemas the packager imports as Effect codecs.
    fn schema_positions(&self) -> (Vec<(&syn::Ident, &Type)>, Option<&Type>) {
        let args = self.args.iter().filter_map(|(name, wire)| if let Wire::Json(ty) = wire { Some((name, ty)) } else { None }).collect();
        let returns = match self.options.mode {
            Mode::InputStream => self.options.returns.as_ref(),
            Mode::OutputStream => None,
            _ => Some(&self.success),
        };
        (args, returns.filter(|ty| matches!(Wire::classify(ty, Mode::Sync), Ok(Wire::Json(_)))))
    }
    /// JS name of the generated schema record function, if any position needs one.
    fn schema_export(&self) -> Option<String> {
        let (args, returns) = self.schema_positions();
        (!args.is_empty() || returns.is_some()).then(|| format!("__effect_rust_schema_{}", self.name()))
    }
    fn manifest(&self) -> serde_json::Value {
        let returns = match self.options.mode {
            Mode::InputStream => self.options.returns.as_ref().map_or_else(|| "json".into(), wire_name),
            Mode::OutputStream => "bytes".into(),
            _ => wire_name(&self.success),
        };
        let mut manifest = serde_json::json!({
            "name": self.name(), "rustName": self.function.sig.ident.to_string(), "mode": self.options.mode.name(),
            "args": self.args.iter().map(|(name,wire)| serde_json::json!({"name":name.to_string(),"type":wire.name()})).collect::<Vec<_>>(),
            "returns": returns,
            "error": self.error.as_ref().map(|error| serde_json::json!({"name":type_name(error),"tagKey":self.options.error_tag,"tagKeySource":if self.options.error_tag_explicit{"explicit"}else{"default"}})),
        });
        if self.options.mode == Mode::Frame { manifest["frame"] = serde_json::json!({"contractId":self.options.contract_id,"version":self.options.version,"codec":"borsh"}); }
        if self.options.mode == Mode::Async {
            manifest["cancellation"] = serde_json::json!(if self.args.iter().any(|(_, wire)| matches!(wire, Wire::Source(_, true))) { "settle-only" } else { "abortable" });
            manifest["asyncAbi"] = serde_json::json!("RustJob");
        }
        if let Some(schema) = self.schema_export() { manifest["schema"] = serde_json::json!(schema); }
        manifest
    }
}
fn iterator_bytes(ty: &Type) -> bool {
    // A concrete iterator's Item is checked by assignment into the byte state.
    if matches!(ty, Type::Path(_)) { return true; }
    if let Type::ImplTrait(implementation) = ty {
        for bound in &implementation.bounds {
            if let syn::TypeParamBound::Trait(bound) = bound {
                if let Some(segment) = bound.path.segments.last() {
                    if segment.ident == "Iterator" {
                        if let PathArguments::AngleBracketed(args) = &segment.arguments {
                            return args.args.iter().any(|argument| matches!(argument, GenericArgument::AssocType(item) if item.ident == "Item" && matches!(Wire::classify(&item.ty,Mode::Sync), Ok(Wire::Bytes))));
                        }
                    }
                }
            }
        }
    }
    false
}

fn expand(args: Tokens, item: Tokens) -> syn::Result<Tokens> {
    let export = Export::parse(Options::parse(args)?, syn::parse2(item)?)?;
    let function = &export.function;
    let ident = &function.sig.ident;
    let module = format_ident!("__effect_rust_export_{}", ident);
    let static_ident = format_ident!("__EFFECT_RUST_EXPORT_{}", ident);
    let mut metadata = b"\0EFFECT_RUST_EXPORT\0".to_vec();
    metadata.extend(serde_json::to_vec(&export.manifest()).map_err(|error| syn::Error::new(Span::call_site(),error.to_string()))?);
    metadata.push(0);
    let length = metadata.len();
    let bytes = syn::LitByteStr::new(&metadata, Span::call_site());
    let wasm = backend::generate(&export, backend::Backend::Wasm)?;
    let napi = backend::generate(&export, backend::Backend::Napi)?;
    Ok(quote! {
        #function
        #[doc(hidden)]
        #[used]
        #[cfg_attr(target_arch = "wasm32", link_section = "effect-rust.exports")]
        #[allow(non_upper_case_globals)]
        #[cfg_attr(not(target_arch = "wasm32"), export_name = concat!("__effect_rust_export_", env!("CARGO_PKG_NAME"), "_", stringify!(#ident)))]
        pub static #static_ident: [u8; #length] = *#bytes;
        #[doc(hidden)]
        #[allow(non_snake_case)]
        #[cfg(any(all(feature = "wasm", target_arch = "wasm32"), all(feature = "napi", not(target_arch = "wasm32"))))]
        mod #module {
            #[allow(unused_imports)]
            use super::*;
            #[cfg(all(feature = "napi", not(target_arch = "wasm32"), not(panic = "unwind")))]
            compile_error!("effect-rust napi exports require panic=unwind");
            #wasm
            #napi
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: Tokens, function: Tokens) -> syn::Result<Export> { Export::parse(Options::parse(args)?, syn::parse2(function)?) }
    #[test]
    fn public_manifest_preserves_names_widths_error_tag_and_frame_header() {
        let export = parse(quote!(frame, name="sumRows", error_tag="reason", contract_id=0xeffec701, version=1), quote!(pub fn sum_rows(rows: &[Sample], offset: u64) -> Result<u64, Fault> { todo!() })).unwrap();
        assert_eq!(export.manifest(), serde_json::json!({"name":"sumRows","rustName":"sum_rows","mode":"frame","args":[{"name":"rows","type":"frame<Sample>"},{"name":"offset","type":"u64"}],"returns":"u64","error":{"name":"Fault","tagKey":"reason","tagKeySource":"explicit"},"frame":{"contractId":0xeffec701u32,"version":1,"codec":"borsh"}}));
    }
    #[test]
    fn distinguishes_default_tag_from_explicit_kind_for_derive_resolution() {
        let function = quote!(fn divide()->Result<u32,Fault>{todo!()});
        let implicit = parse(quote!(), function.clone()).unwrap().manifest();
        let explicit = parse(quote!(error_tag="kind"), function).unwrap().manifest();
        assert_eq!(implicit["error"],serde_json::json!({"name":"Fault","tagKey":"kind","tagKeySource":"default"}));
        assert_eq!(explicit["error"],serde_json::json!({"name":"Fault","tagKey":"kind","tagKeySource":"explicit"}));
    }
    #[test]
    fn rejects_ambiguous_modes_unsafe_width_and_async_borrows() {
        assert!(parse(quote!(sync,borrowed),quote!(fn f(x:u32)->u32{x})).is_err());
        assert!(parse(quote!(),quote!(fn f(x:usize)->usize{x})).is_err());
        assert!(parse(quote!(r#async),quote!(async fn f(x:&[u8])->u32{0})).is_err());
        assert!(parse(quote!(frame),quote!(fn f(x:&[Sample])->u32{0})).is_err());
        assert!(parse(quote!(),quote!(async fn f()->u32{0})).is_err());
    }
    #[test]
    fn admits_streams_and_declared_cancellation_semantics() {
        let input=parse(quote!(input_stream,returns="String"),quote!(fn hasher()->Hasher { todo!() })).unwrap();
        assert_eq!(input.manifest()["returns"],"string");
        let output=parse(quote!(output_stream),quote!(fn chunks()->Result<impl Iterator<Item=Vec<u8>>,Fault>{todo!()})).unwrap();
        assert_eq!(output.manifest()["returns"],"bytes");
        let source=parse(quote!(r#async),quote!(async fn read(source:host::Source<host::SettleOnly>)->Vec<u8>{todo!()})).unwrap();
        assert_eq!(source.manifest()["cancellation"],"settle-only");
    }
}
