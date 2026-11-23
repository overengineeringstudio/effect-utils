//! Client modes of the same immutable executable as the authenticated server.
//! No independent client binary or alternate socket/policy authority is used.
use std::ffi::OsStr;
use std::io::{self, Write};
use std::time::Instant;
use super::{bounded_input, digest, host_identity, linux, protocol, request, client_transport, PRODUCER, POLICY, INITIAL_NAMESPACES};
use protocol::{Kind, Request, Response, Status};

fn client_response(request: &Request, input: &[u8], deadline: Instant) -> io::Result<Response> {
    let requested_at=linux::boot_time_ns()?;
    let output=client_transport::exchange(input,deadline)?;
    let response=Response::parse(&output)?;
    let (host,boot)=host_identity(deadline)?;
    let paths=digest::digest(request.paths_receipt(),deadline)?;
    response.validate(request,PRODUCER,POLICY,&host,&boot,INITIAL_NAMESPACES,&paths,linux::boot_time_ns()?)?;
    if response.capture.started_boot_ns<requested_at { return Err(io::Error::other("capture predates this request")); }
    Ok(response)
}
pub(super) fn worktree_client(deadline: Instant) -> io::Result<()> {
    // Do not manufacture a reader-owned cwd reference to the requested tree.
    // Other inherited resources are still ordinary census subjects, not waived.
    std::env::set_current_dir("/")?;
    let input=bounded_input(io::stdin().lock(),protocol::MAX_REQUEST)?;
    let request=Request::parse(&input,false)?;
    // The exact input bytes, not a normalized alternate JSON spelling, are the
    // authenticated GET payload. The root parses the same strict schema again.
    let response=client_response(&request,&input,deadline)?;
    let output=response.serialize()?;
    // Account for validation/serialization time before exposing fresh evidence.
    if linux::boot_time_ns()?>=response.capture.expires_boot_ns { return Err(io::Error::other("expired holder evidence")); }
    let mut stdout=io::stdout().lock(); stdout.write_all(&output)?; stdout.write_all(b"\n")?; stdout.flush()
}
pub(super) fn store_client(deadline: Instant) -> io::Result<()> {
    std::env::set_current_dir("/")?;
    let mut arguments=std::env::args_os().skip(2);
    if arguments.next().as_deref()!=Some(OsStr::new("--pnpm-store-evidence-v1")) { return Err(io::Error::other("missing fixed pnpm adapter selector")); }
    let store=request::StoreRequest::parse(arguments).map_err(io::Error::other)?;
    let request=Request {version:1,nonce:store.nonce.clone(),kind:Kind::Store,paths:vec![store.candidate.clone()],store:Some(store)};
    let response=client_response(&request,&request.serialize()?,deadline)?;
    let root=&response.roots[0]; let store=request.store.as_ref().ok_or_else(||io::Error::other("missing store binding"))?;
    if !response.scope.complete || !root.complete || !root.references_complete || root.status!=Status::NoCurrentReference
        || root.identity.as_ref().is_none_or(|id|id.dev!=store.device||id.ino!=store.inode)
        || linux::boot_time_ns()?>=response.capture.expires_boot_ns { return Err(io::Error::other("store not proved absent")); }
    let line=format!("pnpm-store-evidence-v1\t{}\t{}\t{}\tabsent\t{}\t{}\n",store.nonce,store.device,store.inode,response.scope.digest,store.client_start);
    if line.len()>256 { return Err(io::Error::other("pnpm evidence output bound")); }
    let mut stdout=io::stdout().lock(); stdout.write_all(line.as_bytes())?; stdout.flush()
}
