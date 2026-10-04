use super::{backend, Export, Mode, Options, Tokens};
use proc_macro2::Span;
use quote::{format_ident, quote};
use syn::{FnArg, ImplItem, ItemFn, ItemImpl, ReturnType, Type, Visibility};

pub(super) fn expand(args: Tokens, item: Tokens) -> syn::Result<Tokens> {
    if !args.is_empty() && !matches!(syn::parse2::<syn::Meta>(args.clone()), Ok(syn::Meta::NameValue(value)) if value.path.is_ident("name")) {
        return Err(syn::Error::new(Span::call_site(), "resource accepts only name = \"factoryName\""));
    }
    let options = Options::parse(args)?;
    if options.mode != Mode::Sync || options.error_tag_explicit {
        return Err(syn::Error::new(Span::call_site(), "resource accepts only name = \"factoryName\"; methods use their ExportError serde tag"));
    }
    let implementation: ItemImpl = syn::parse2(item)?;
    if implementation.trait_.is_some() || implementation.unsafety.is_some() || !implementation.generics.params.is_empty() || implementation.generics.where_clause.is_some() {
        return Err(syn::Error::new_spanned(&implementation, "resource requires a safe, non-generic inherent impl"));
    }
    if implementation.attrs.iter().any(|attribute| !attribute.path().is_ident("doc")) {
        return Err(syn::Error::new_spanned(&implementation, "resource impl supports only documentation attributes; apply cfg to its enclosing module"));
    }
    let Type::Path(path) = implementation.self_ty.as_ref() else {
        return Err(syn::Error::new_spanned(&implementation.self_ty, "resource requires a named concrete type"));
    };
    if path.qself.is_some() || path.path.segments.iter().any(|segment| !matches!(segment.arguments, syn::PathArguments::None)) {
        return Err(syn::Error::new_spanned(path, "resource types cannot have generic arguments"));
    }
    let class = path.path.segments.last().unwrap().ident.to_string();
    let name = options.name.unwrap_or_else(|| {
        let mut chars = class.chars();
        format!("{}{}", chars.next().unwrap().to_ascii_lowercase(), chars.as_str())
    });
    syn::parse_str::<syn::Ident>(&name).map_err(|_| syn::Error::new(Span::call_site(), "resource factory name must be a Rust/JavaScript identifier"))?;
    let mut constructor = None;
    let mut methods = Vec::new();
    for member in &implementation.items {
        let ImplItem::Fn(method) = member else {
            return Err(syn::Error::new_spanned(member, "resource impl accepts methods only; move associated items to another impl"));
        };
        if !matches!(method.vis, Visibility::Public(_)) { continue; }
        if method.sig.ident == "close" || method.sig.ident == "free" {
            return Err(syn::Error::new_spanned(&method.sig, "resource reserves close and free for deterministic release"));
        }
        if method.attrs.iter().any(|attribute| !attribute.path().is_ident("doc")) {
            return Err(syn::Error::new_spanned(method, "resource methods support only documentation attributes; move conditional/private helpers to another impl"));
        }
        if method.sig.asyncness.is_some() || method.sig.generics.where_clause.is_some() {
            return Err(syn::Error::new_spanned(&method.sig, "resource methods must be synchronous and non-generic"));
        }
        let mut signature = method.sig.clone();
        let is_constructor = signature.ident == "new";
        if is_constructor {
            if signature.receiver().is_some() || !matches!(&signature.output, ReturnType::Type(_, ty) if matches!(ty.as_ref(), Type::Path(path) if path.path.is_ident("Self"))) {
                return Err(syn::Error::new_spanned(&signature, "resource constructor must be public new(...) -> Self, without a receiver or Result"));
            }
            signature.output = syn::parse_quote!(-> ());
        } else {
            let Some(receiver) = signature.receiver() else {
                return Err(syn::Error::new_spanned(&signature, "resource exports only new and borrowed receiver methods; move static helpers to a private impl"));
            };
            if receiver.reference.is_none() || receiver.colon_token.is_some() {
                return Err(syn::Error::new_spanned(receiver, "resource methods require &self or &mut self; consuming/typed receivers are unsupported"));
            }
            signature.inputs = signature.inputs.into_iter().filter(|arg| !matches!(arg, FnArg::Receiver(_))).collect();
        }
        let mut method_options = Options::parse(Tokens::new())?;
        method_options.name = Some(if is_constructor { name.clone() } else { format!("{name}_{}", signature.ident) });
        let function = ItemFn { attrs: vec![], vis: method.vis.clone(), sig: signature, block: Box::new(method.block.clone()) };
        let export = Export::parse(method_options, function)?;
        fn owns_resource(ty: &Type, class: &str) -> bool {
            matches!(super::type_name(ty).as_str(), "Self") || super::type_name(ty) == class
                || super::generic_types(ty).iter().any(|ty| owns_resource(ty, class))
        }
        if export.args.iter().any(|(_, wire)| matches!(wire, super::Wire::Json(ty) if owns_resource(ty, &class)))
            || owns_resource(&export.success, &class) || export.error.as_ref().is_some_and(|ty| owns_resource(ty, &class)) {
            return Err(syn::Error::new_spanned(method, "resources cannot cross method arguments/results; return a serde domain value instead"));
        }
        if is_constructor { constructor = Some(export); } else { methods.push(export); }
    }
    let constructor = constructor.ok_or_else(|| syn::Error::new_spanned(&implementation, "resource requires public fn new(...) -> Self"))?;
    let ty = &implementation.self_ty;
    let module = format_ident!("__effect_rust_resource_{name}");
    let mut metadata = Vec::new();
    for (export, role) in std::iter::once((&constructor, "constructor")).chain(methods.iter().map(|method| (method, "method"))).chain(std::iter::once((&constructor, "close"))) {
        let mut manifest = export.manifest();
        let symbol = if role == "close" { format!("{name}_close") } else { export.name() };
        manifest["resource"] = serde_json::json!({"name":name,"type":class,"role":role,"method":if role == "close" { "close".to_owned() } else { export.function.sig.ident.to_string() },"concurrency":"serial"});
        if role == "constructor" { manifest["returns"] = serde_json::json!("resource"); }
        if role == "close" {
            manifest["name"] = serde_json::json!(symbol);
            manifest["rustName"] = serde_json::json!("drop");
            manifest["returns"] = serde_json::json!("void");
            manifest["args"] = serde_json::json!([]);
            manifest["error"] = serde_json::Value::Null;
            manifest.as_object_mut().unwrap().remove("schema");
        }
        let ident = format_ident!("__EFFECT_RUST_RESOURCE_{symbol}");
        let mut bytes = b"\0EFFECT_RUST_EXPORT\0".to_vec();
        bytes.extend(serde_json::to_vec(&manifest).map_err(|error| syn::Error::new(Span::call_site(), error.to_string()))?);
        bytes.push(0);
        let length = bytes.len();
        let literal = syn::LitByteStr::new(&bytes, Span::call_site());
        metadata.push(quote! {
            // Metadata symbols preserve the public JavaScript export name.
            #[doc(hidden)] #[used] #[allow(non_upper_case_globals)]
            #[cfg_attr(target_arch = "wasm32", link_section = "effect-rust.exports")]
            #[cfg_attr(not(target_arch = "wasm32"), export_name = concat!("__effect_rust_resource_", env!("CARGO_PKG_NAME"), "_", #symbol))]
            pub static #ident: [u8; #length] = *#literal;
        });
    }
    let wasm = backend::resource(ty, &class, &constructor, &methods, backend::Backend::Wasm)?;
    let native = backend::resource(ty, &class, &constructor, &methods, backend::Backend::Napi)?;
    Ok(quote! {
        #implementation
        #(#metadata)*
        // Public factory names may be camelCase; the generated module mirrors that name.
        #[doc(hidden)] #[allow(non_snake_case)]
        #[cfg(any(all(feature = "wasm", target_arch = "wasm32"), all(feature = "napi", not(target_arch = "wasm32"))))]
        mod #module {
            use super::*;
            #[cfg(all(feature = "napi", not(target_arch = "wasm32"), not(panic = "unwind")))]
            compile_error!("effect-rust napi resources require panic=unwind");
            #wasm #native
        }
    })
}
