use super::{Export, Mode, Tokens, Wire};
use quote::{format_ident, quote};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Backend { Wasm, Napi }
impl Backend {
    fn error(self) -> Tokens { match self { Self::Wasm => quote!(wasm_bindgen::JsValue), Self::Napi => quote!(napi::Error) } }
    fn annotation(self, name: &str) -> Tokens {
        match self { Self::Wasm => quote!(#[wasm_bindgen::prelude::wasm_bindgen(js_name = #name)]), Self::Napi => quote!(#[napi_derive::napi(js_name = #name)]) }
    }
    fn wire_type(self, wire: &Wire) -> Tokens {
        match wire {
            Wire::Unit => quote!(()), Wire::Scalar(ty) => quote!(#ty), Wire::String | Wire::Wide(_) => quote!(String),
            Wire::Bytes => match self { Self::Wasm => quote!(Vec<u8>), Self::Napi => quote!(napi::bindgen_prelude::Buffer) },
            Wire::BorrowedBytes | Wire::Frame(_) => match self { Self::Wasm => quote!(&[u8]), Self::Napi => quote!(napi::bindgen_prelude::BufferSlice<'_>) },
            Wire::Json(_) => match self { Self::Wasm => quote!(wasm_bindgen::JsValue), Self::Napi => quote!(serde_json::Value) },
            Wire::Source(_, _) => match self {
                Self::Wasm => quote!(js_sys::Function),
                Self::Napi => quote!(napi::threadsafe_function::ThreadsafeFunction<String, napi::bindgen_prelude::Promise<napi::bindgen_prelude::Buffer>, String, napi::Status, false>),
            },
        }
    }
    fn decode(self, name: &syn::Ident, wire: &Wire, export: &Export) -> Tokens {
        match wire {
            Wire::Scalar(ty) if self == Self::Napi && super::type_name(ty) == "f32" => quote! {
                if !#name.is_finite() || #name.abs() > f64::from(f32::MAX) {
                    return Err(edge_error("RUST_INPUT:expected a finite f32"));
                }
                let #name = #name as f32;
            },
            Wire::Scalar(ty) if matches!(super::type_name(ty).as_str(), "f32" | "f64") => quote! {
                if !#name.is_finite() { return Err(edge_error("RUST_INPUT:expected a finite float")); }
            },
            Wire::Wide(ty) => quote! {
                let digits=#name.strip_prefix('-').unwrap_or(&#name).as_bytes();
                if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit)
                    || (digits.len()>1 && digits[0]==b'0') || #name=="-0" {
                    return Err(edge_error("RUST_INPUT:noncanonical decimal integer"));
                }
                let #name: #ty = #name.parse().map_err(|_| edge_error("RUST_INPUT:invalid decimal integer"))?;
            },
            Wire::Bytes if self == Self::Napi => quote!(let #name = #name.to_vec();),
            Wire::BorrowedBytes if self == Self::Napi => quote!(let #name: &[u8] = #name.as_ref();),
            Wire::Frame(row) => {
                let id = export.options.contract_id.unwrap(); let version = export.options.version.unwrap();
                quote!(let #name: Vec<#row> = effect_rust::frame::decode(#name.as_ref(), #id, #version).map_err(|error| edge_error(format!("RUST_INPUT:{error}")))?;)
            }
            Wire::Json(ty) => match self {
                Self::Wasm => quote! {
                    let #name: serde_json::Value = serde_wasm_bindgen::from_value(#name).map_err(|error| edge_error(format!("RUST_INPUT:{error}")))?;
                    let #name: #ty = serde_json::from_value(#name).map_err(|error| edge_error(format!("RUST_INPUT:{error}")))?;
                },
                Self::Napi => quote!(let #name: #ty = serde_json::from_value(#name).map_err(|error| edge_error(format!("RUST_INPUT:{error}")))?;),
            },
            Wire::Source(ty, _) => {
                let construct = match self {
                    Self::Wasm => quote! {
                        let callback = #name.clone();
                        let #name: #ty = effect_rust::host::Source::new(move |path: &str, _token| {
                            let callback = callback.clone(); let path = path.to_owned();
                            Box::pin(async move {
                                let value = callback.call1(&wasm_bindgen::JsValue::UNDEFINED, &wasm_bindgen::JsValue::from_str(&path))
                                    .map_err(|error| effect_rust::host::Error::failed(format!("{error:?}")))?;
                                let value = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&value)).await
                                    .map_err(|error| effect_rust::host::Error::failed(format!("{error:?}")))?;
                                if !value.is_instance_of::<js_sys::Uint8Array>() { return Err(effect_rust::host::Error::failed("host read must return Uint8Array")); }
                                Ok(js_sys::Uint8Array::new(&value).to_vec())
                            })
                        }).with_cancellation(__token.clone());
                    },
                    Self::Napi => quote! {
                        let callback = std::sync::Arc::new(#name);
                        let #name: #ty = effect_rust::host::Source::new(move |path: &str, _token| {
                            let callback = callback.clone(); let path = path.to_owned();
                            Box::pin(async move {
                                let promise = callback.call_async_catch(path).await.map_err(|error| effect_rust::host::Error::failed(error.to_string()))?;
                                let bytes = promise.await.map_err(|error| effect_rust::host::Error::failed(error.to_string()))?;
                                Ok(bytes.to_vec())
                            })
                        }).with_cancellation(__token.clone());
                    },
                };
                construct
            }
            _ => quote!(),
        }
    }
    fn encode(self, wire: &Wire, value: Tokens) -> Tokens {
        match wire {
            Wire::Scalar(ty) if matches!(super::type_name(ty).as_str(), "f32" | "f64") => quote! {
                if !#value.is_finite() { return Err(edge_error("RUST_TRANSPORT:non-finite float result")); }
                Ok(#value)
            },
            Wire::Wide(_) => quote!(Ok(#value.to_string())),
            Wire::Bytes if self == Self::Napi => quote!(Ok(napi::bindgen_prelude::Buffer::from(#value))),
            Wire::Json(_) => match self {
                Self::Wasm => quote! {
                    let value = serde_json::to_value(&#value).map_err(|error| edge_error(format!("RUST_TRANSPORT:{error}")))?;
                    serde::Serialize::serialize(&value,&serde_wasm_bindgen::Serializer::json_compatible())
                        .map_err(|error| edge_error(format!("RUST_TRANSPORT:{error}")))
                },
                Self::Napi => quote!(serde_json::to_value(&#value).map_err(|error| edge_error(format!("RUST_TRANSPORT:{error}")))),
            },
            _ => quote!(Ok(#value)),
        }
    }
}

pub(super) fn generate(export: &Export, backend: Backend) -> syn::Result<Tokens> {
    let module = match backend { Backend::Wasm => quote!(wasm), Backend::Napi => quote!(native) };
    let cfg = match backend { Backend::Wasm => quote!(all(feature="wasm",target_arch="wasm32")), Backend::Napi => quote!(all(feature="napi",not(target_arch="wasm32"))) };
    let error = backend.error();
    let edge_error = match backend {
        Backend::Wasm => quote!(js_sys::Error::new(&message.to_string()).into()),
        Backend::Napi => quote!(napi::Error::from_reason(message.to_string())),
    };
    let body = match export.options.mode {
        Mode::InputStream | Mode::OutputStream => stream(export,backend)?,
        Mode::Async => asynchronous(export,backend)?,
        _ => synchronous(export,backend)?,
    };
    let expected = if export.error.is_some() { quote! {
        fn expected_error<E: serde::Serialize + effect_rust::ExportError>(error: &E) -> #error {
            let value = match serde_json::to_value(error) {
                Ok(value) => value,
                Err(error) => return edge_error(format!("RUST_TRANSPORT:{error}")),
            };
            struct Tagged<'a>(&'a serde_json::Value, &'static str);
            impl serde::Serialize for Tagged<'_> {
                fn serialize<S: serde::Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
                    use serde::ser::SerializeMap as _;
                    let Some(object)=self.0.as_object() else {return serde::Serialize::serialize(self.0,serializer);};
                    let mut map=serializer.serialize_map(Some(object.len()))?;
                    if let Some(tag)=object.get(self.1){map.serialize_entry(self.1,tag)?;}
                    for (key,value) in object {if key!=self.1{map.serialize_entry(key,value)?;}}
                    map.end()
                }
            }
            match serde_json::to_string(&Tagged(&value,E::TAG_KEY)) {
                Ok(json)=>edge_error(format!("RUST_ERROR:{json}")),
                Err(error)=>edge_error(format!("RUST_TRANSPORT:{error}")),
            }
        }
    } } else { quote!() };
    let schema = export.schema_export().map(|name| {
        let annotation = backend.annotation(&name);
        let (args, returns) = export.schema_positions();
        let args = args.into_iter().map(|(name, ty)| { let name = name.to_string(); quote!(.arg::<#ty>(#name)) });
        let returns = returns.map(|ty| quote!(.returns::<#ty>()));
        // Packaging-time metadata: schemars runs inside the built product, so the
        // schemas reflect the exact serde/schemars attributes compiled into it.
        quote! {
            #annotation
            pub fn schema() -> String {
                effect_rust::contract::ExportSchema::default() #(#args)* #returns .into_json().to_string()
            }
        }
    });
    Ok(quote! {
        #[cfg(#cfg)]
        mod #module {
            #[allow(unused_imports)]
            use super::*;
            #[cfg(target_arch="wasm32")]
            use wasm_bindgen::JsCast as _;
            fn edge_error(message: impl std::fmt::Display) -> #error { #edge_error }
            #expected
            #body
            #schema
        }
    })
}

fn arguments(export: &Export, backend: Backend) -> (Vec<Tokens>, Vec<Tokens>, Vec<Tokens>) {
    let mut declarations=Vec::new(); let mut decode=Vec::new(); let mut calls=Vec::new();
    for (name,wire) in &export.args {
        let ty=if backend==Backend::Napi && matches!(wire, Wire::Scalar(ty) if super::type_name(ty)=="f32") {
            quote!(f64)
        } else { backend.wire_type(wire) };
        declarations.push(quote!(#name: #ty));
        decode.push(backend.decode(name,wire,export));
        calls.push(if matches!(wire,Wire::Frame(_)) { quote!(&#name) } else { quote!(#name) });
    }
    (declarations,decode,calls)
}
fn result(export:&Export,call:Tokens)->Tokens {
    if export.error.is_some() { quote!(let __value=#call.map_err(|error| expected_error(&error))?;) } else { quote!(let __value=#call;) }
}
fn synchronous(export:&Export,backend:Backend)->syn::Result<Tokens> {
    let name=export.name(); let annotation=backend.annotation(&name); let ident=&export.function.sig.ident;
    let (declarations,decode,calls)=arguments(export,backend);
    let wire=Wire::classify(&export.success,Mode::Sync)?; let output=backend.wire_type(&wire); let error=backend.error();
    let value=result(export,quote!(super::super::#ident(#(#calls),*))); let encode=backend.encode(&wire,quote!(__value));
    Ok(quote! {
        #annotation
        pub fn call(#(#declarations),*) -> Result<#output,#error> {
            effect_rust::native::guard(#name, || {
                #(#decode)* #value #encode
            }).map_err(edge_error)?
        }
    })
}

fn stream(export:&Export,backend:Backend)->syn::Result<Tokens> {
    let name=export.name(); let ident=&export.function.sig.ident;
    let mut rust_class_name=String::from("EffectRust");
    let mut capitalize=true;
    for ch in ident.to_string().trim_start_matches("r#").chars(){
        if ch=='_'{capitalize=true;}
        else{rust_class_name.push(if capitalize{ch.to_ascii_uppercase()}else{ch});capitalize=false;}
    }
    rust_class_name.push_str("Stream");
    let class=format_ident!("{}",rust_class_name);
    let class_name=format!("EffectRust{}Stream",name);
    let annotation=backend.annotation(&name); let class_annotation=backend.annotation(&class_name);
    let impl_annotation=match backend { Backend::Wasm=>quote!(#[wasm_bindgen::prelude::wasm_bindgen(js_class = #class_name)]),Backend::Napi=>quote!(#[napi_derive::napi]) };
    let (declarations,decode,calls)=arguments(export,backend); let error=backend.error();
    let bytes=backend.wire_type(&Wire::BorrowedBytes);
    // Erasure is necessary only for an opaque impl Iterator return type.
    let concrete = export.options.mode==Mode::InputStream || matches!(export.success,syn::Type::Path(_));
    let state=if concrete { let ty=&export.success;quote!(#ty) } else { quote!(Box<dyn Iterator<Item=effect_rust::Bytes>>) };
    let create=result(export,quote!(super::super::#ident(#(#calls),*)));
    let store=if concrete {quote!(__value)} else {quote!(Box::new(__value))};
    let close_annotation=backend.annotation("close");
    let free=if backend==Backend::Napi {
        let annotation=backend.annotation("free");
        quote!(#annotation pub fn free(&mut self)->Result<(),#error>{ self.close() })
    } else { quote!() };
    let (extra_fields, extra_init, extra_close, extra_drop) = if export.options.mode == Mode::OutputStream {
        (quote!(pending: Option<effect_rust::Bytes>, offset: usize,),
         quote!(pending: None, offset: 0,),
         quote!(self.pending = None; self.offset = 0;),
         quote!(let pending = self.pending.take(); drop(pending);))
    } else { (quote!(), quote!(), quote!(), quote!()) };
    let methods=if export.options.mode==Mode::InputStream {
        let write_annotation=backend.annotation("write"); let update_annotation=backend.annotation("update");let finish_annotation=backend.annotation("finish");
        let finish_wire=export.options.returns.as_ref().map(|ty|Wire::classify(ty,Mode::Sync)).transpose()?.unwrap_or_else(|| Wire::Json(syn::parse_quote!(serde_json::Value)));
        let output=backend.wire_type(&finish_wire);let encode=backend.encode(&finish_wire,quote!(__value));
        quote! {
            #write_annotation
            pub fn write(&mut self, bytes:#bytes)->Result<(),#error>{
                effect_rust::native::guard(concat!(#name,".write"),||{
                    let state=self.state.as_mut().ok_or_else(||edge_error("RUST_INPUT:stream closed"))?;
                    state.update(bytes.as_ref()); Ok(())
                }).map_err(edge_error)?
            }
            #update_annotation
            pub fn update(&mut self,bytes:#bytes)->Result<(),#error>{ self.write(bytes) }
            #finish_annotation
            pub fn finish(&mut self)->Result<#output,#error>{
                effect_rust::native::guard(concat!(#name,".finish"),||{
                    let state=self.state.take().ok_or_else(||edge_error("RUST_INPUT:stream closed"))?;
                    let __value=state.finish(); #encode
                }).map_err(edge_error)?
            }
        }
    } else {
        let next_annotation=backend.annotation("next");
        let output=if backend==Backend::Napi {
            quote!(napi::bindgen_prelude::Either<napi::bindgen_prelude::Buffer,()>)
        } else {quote!(Option<Vec<u8>>)};
        let value=if backend==Backend::Napi {quote!(match value {
            Some(bytes)=>napi::bindgen_prelude::Either::A(napi::bindgen_prelude::Buffer::from(bytes)),
            None=>napi::bindgen_prelude::Either::B(()),
        })} else {quote!(value)};
        quote! {
            #next_annotation
            pub fn next(&mut self,max_bytes:Option<u32>)->Result<#output,#error>{
                effect_rust::native::guard(concat!(#name,".next"),||{
                    let max_bytes=max_bytes.unwrap_or(u32::MAX) as usize;
                    if max_bytes==0 {return Err(edge_error("RUST_INPUT:maxBytes must be positive"));}
                    if self.pending.is_none() {
                        self.pending=match self.state.as_mut(){Some(state)=>state.next(),None=>None};
                        self.offset=0;
                    }
                    let value=match self.pending.as_ref() {
                        None=>{self.state=None;None},
                        Some(chunk) if self.offset==0 && chunk.len()<=max_bytes=>self.pending.take(),
                        Some(chunk)=>{
                            let end=self.offset+max_bytes.min(chunk.len()-self.offset);
                            let value=chunk[self.offset..end].to_vec();
                            self.offset=end;
                            if end==chunk.len(){self.pending=None;self.offset=0;}
                            Some(value)
                        }
                    };
                    Ok(#value)
                }).map_err(edge_error)?
            }
        }
    };
    Ok(quote! {
        #class_annotation
        pub struct #class { state:Option<#state>, #extra_fields }
        #impl_annotation
        impl #class {
            #methods
            #close_annotation
            pub fn close(&mut self)->Result<(),#error>{
                effect_rust::native::guard(concat!(#name,".close"),||{ self.state=None; #extra_close Ok(()) }).map_err(edge_error)?
            }
            #free
        }
        impl Drop for #class {
            fn drop(&mut self){
                let state=self.state.take();
                let _=effect_rust::native::guard(concat!(#name,".drop"),||{drop(state); #extra_drop});
            }
        }
        #annotation
        pub fn call(#(#declarations),*)->Result<#class,#error>{
            effect_rust::native::guard(#name,||{#(#decode)* #create Ok(#class{state:Some(#store), #extra_init})}).map_err(edge_error)?
        }
    })
}

fn asynchronous(export:&Export,backend:Backend)->syn::Result<Tokens> {
    let name=export.name(); let ident=&export.function.sig.ident;let annotation=backend.annotation(&name);let error=backend.error();
    let (declarations,decode,calls)=arguments(export,backend);
    let wire=Wire::classify(&export.success,Mode::Sync)?;let encode=backend.encode(&wire,quote!(__value));
    let settle=export.args.iter().any(|(_,wire)|matches!(wire,Wire::Source(_,true)));
    let mode=if settle{"settle-only"}else{"abortable"};
    let guarded=quote! {
        let __future=effect_rust::native::guard(#name,||super::super::#ident(#(#calls),*)).map_err(edge_error)?;
    };
    let await_value=if settle {
        quote!(let __result=__future.await;)
    } else {
        quote!(let __result=effect_rust::host::cancel_future(&__token,__future).await.map_err(|error|edge_error(format!("RUST_CANCELLED:{error}")))?;)
    };
    let unwrap=if export.error.is_some(){quote!(let __value=__result.map_err(|error|expected_error(&error))?;)}else{quote!(let __value=__result;)};
    // Completion is notified only after the inner async scope and its future/captured
    // host capabilities have been destroyed, so cancel acknowledgement is quiescent.
    let work=quote! {
        let __result=effect_rust::native::guard_future(#name,async move { #guarded #await_value #unwrap #encode }).await;
        __done.cancel();
        __result.map_err(edge_error)?
    };
    let promise_value = match &wire {
        Wire::Json(_) => quote!(Ok(value)),
        Wire::Bytes => quote!(Ok(js_sys::Uint8Array::from(value.as_slice()).into())),
        Wire::Unit => quote!(Ok(wasm_bindgen::JsValue::UNDEFINED)),
        _ => quote!(Ok(wasm_bindgen::JsValue::from(value))),
    };
    match backend {
        Backend::Wasm=>Ok(quote! {
            #annotation
            pub fn call(#(#declarations),*)->Result<wasm_bindgen::JsValue,#error>{
                effect_rust::native::guard(#name,||{
                    let __token=effect_rust::CancellationToken::new();
                    let __completion=effect_rust::CancellationToken::new();
                    let __done=__completion.clone();let __cancel=__token.clone();
                    #(#decode)*
                    let result=wasm_bindgen_futures::future_to_promise(async move {
                        let value:Result<_,#error>=async move { #work }.await;
                        value.and_then(|value| { #promise_value })
                    });
                    let cancel=wasm_bindgen::closure::Closure::wrap(Box::new(move ||->js_sys::Promise {
                        __cancel.cancel();let completion=__completion.clone();
                        wasm_bindgen_futures::future_to_promise(async move{completion.cancelled().await;Ok(wasm_bindgen::JsValue::UNDEFINED)})
                    }) as Box<dyn Fn()->js_sys::Promise>).into_js_value();
                    let object=js_sys::Object::new();
                    js_sys::Reflect::set(&object,&wasm_bindgen::JsValue::from_str("_tag"),&wasm_bindgen::JsValue::from_str("RustJob"))?;
                    js_sys::Reflect::set(&object,&wasm_bindgen::JsValue::from_str("mode"),&wasm_bindgen::JsValue::from_str(#mode))?;
                    js_sys::Reflect::set(&object,&wasm_bindgen::JsValue::from_str("result"),&result)?;
                    js_sys::Reflect::set(&object,&wasm_bindgen::JsValue::from_str("cancel"),&cancel)?;
                    Ok(object.into())
                }).map_err(edge_error)?
            }
        }),
        Backend::Napi=>Ok(quote! {
            #annotation
            pub fn call(env:napi::Env,#(#declarations),*)->Result<napi::bindgen_prelude::Object<'static>,#error>{
                effect_rust::native::guard(#name,||{
                    use napi::JsValue as _;
                    let __token=effect_rust::CancellationToken::new();
                    let __completion=effect_rust::CancellationToken::new();
                    let __done=__completion.clone();let __cancel=__token.clone();
                    #(#decode)*
                    let result=env.spawn_future(async move { #work })?;
                    let cancel=env.create_function_from_closure::<(),napi::bindgen_prelude::Object<'static>,_>("cancel",move |ctx| {
                        effect_rust::native::guard(concat!(#name,".cancel"),||{
                            __cancel.cancel();let completion=__completion.clone();
                            let promise=ctx.env.spawn_future(async move{completion.cancelled().await;Ok(())})?;
                            Ok(napi::bindgen_prelude::Object::from_raw(ctx.env.raw(),promise.raw()))
                        }).map_err(edge_error)?
                    })?;
                    let mut object=napi::bindgen_prelude::Object::new(&env)?;
                    object.set("_tag","RustJob")?;object.set("mode",#mode)?;
                    object.set("result",result)?;object.set("cancel",cancel)?;
                    Ok(napi::bindgen_prelude::Object::from_raw(env.raw(),object.raw()))
                }).map_err(edge_error)?
            }
        }),
    }
}
