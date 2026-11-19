//! Fixed-policy, read-only all-UID holder observations for worktrees and pnpm.
//! This binary never deletes, acquires a caller's lease, or authorizes action.
//! --client-v1 reads strict v1 worktree JSON; --pnpm-client-v1 adapts the
//! seven-field GC contract. Both use only the compiled root-owned Unix socket.
//! --serve-once requires an authenticated socket-activated root management role.
#![deny(unsafe_code)]
#[cfg(not(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
compile_error!("worktree-holder-evidence requires Linux x86_64 or aarch64 kernel interfaces");
#[path = "worktree-holder-evidence-request.rs"]
mod request;
#[allow(unsafe_code)]
#[path = "worktree-holder-evidence-linux.rs"]
mod linux;
#[path = "worktree-holder-evidence-objects.rs"]
mod objects;
#[path = "worktree-holder-evidence-client.rs"]
mod client;
#[path = "worktree-holder-evidence-mounts.rs"]
mod mounts;
#[path = "worktree-holder-evidence-candidates.rs"]
mod candidates;
#[path = "worktree-holder-evidence-listener.rs"]
mod listener;
#[path = "worktree-holder-evidence-decode.rs"]
mod decode;
#[path = "worktree-holder-evidence-daemon.rs"]
mod daemon;
#[path = "worktree-holder-evidence-host-ipc.rs"]
mod host_ipc;
#[path = "worktree-holder-evidence-runtime.rs"]
mod runtime;
#[path = "worktree-holder-evidence-census.rs"]
mod census;
#[path = "worktree-holder-evidence-protocol.rs"]
mod protocol;
#[path = "worktree-holder-evidence-transport.rs"]
mod transport;

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};
use protocol::{Capture, Kind, Observation, Request, Response, RootEvidence, Scope, Status, UnknownReason};
const INITIAL_NAMESPACES: [u64;4] = [4026531837,4026531836,4026531832,4026531833];
const PRODUCER: &str = env!("HOLDER_EVIDENCE_PRODUCER_ID");
const POLICY: &str = env!("HOLDER_EVIDENCE_POLICY_ID");

fn bounded_input(input: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes=Vec::new(); input.take((limit+1) as u64).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len()>limit { return Err(io::Error::other("holder-evidence input bound")); } Ok(bytes)
}
fn host_identity(deadline: Instant) -> io::Result<(String,String)> {
    let machine=bounded_input(File::open("/etc/machine-id")?,33)?;
    let text=std::str::from_utf8(&machine).map_err(|_|io::Error::other("invalid machine identity"))?;
    if !protocol::hex(text.strip_suffix('\n').unwrap_or(text),32) { return Err(io::Error::other("invalid machine identity")); }
    // Hash exact fixed machine-id file bytes, including LF when present.
    let host=decode::digest(machine,deadline)?;
    let boot=bounded_input(File::open("/proc/sys/kernel/random/boot_id")?,37)?;
    let boot=std::str::from_utf8(&boot).map_err(|_|io::Error::other("invalid boot identity"))?;
    let boot=boot.strip_suffix('\n').ok_or_else(||io::Error::other("invalid boot identity"))?;
    if boot.len()!=36 || !boot.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i) {b==b'-'} else {b.is_ascii_digit()||(b'a'..=b'f').contains(&b)}) { return Err(io::Error::other("invalid boot identity")); }
    Ok((host,boot.to_owned()))
}
fn unknown(request: &Request, cause: UnknownReason) -> Observation {
    Observation {complete:false,process_count:0,task_count:0,receipt:b"incomplete-holder-observation-v1\0".to_vec(),roots:request.paths.iter().map(|path|RootEvidence {path:path.clone(),identity:None,complete:false,status:Status::Unknown,references_complete:false,references:Vec::new(),unknown_reasons:vec![cause]}).collect()}
}
fn collect(request: &Request, peer: &client::Peer, role: &client::SelfRole, deadline: Instant) -> io::Result<(Observation,candidates::CandidateSet,Option<client::Client>,client::PeerRoots)> {
    let candidates=candidates::CandidateSet::pin(request,peer.uid,deadline)?;
    let peer_roots=client::PeerRoots::pin(peer,&candidates,deadline)?;
    // Store pinning opens roots only. Inventory starts ONLY after the original
    // collector's root and EX FLOCK OFDs have been authenticated and retained.
    let store_client=match &request.store {
        Some(store)=>Some(client::Client::attest_from_peer(peer,store,peer.uid,peer_roots.root(0))?),
        None=>None,
    };
    let census=census::Census::collect(request,&candidates,store_client.as_ref(),peer,role,deadline)?;
    census.recheck(&candidates,store_client.as_ref(),deadline)?;
    candidates.recheck(deadline)?;
    peer_roots.recheck(peer,deadline)?;
    if let (Some(client),Some(store))=(&store_client,&request.store) { client.recheck(store)?; }
    peer.recheck(deadline)?;
    role.recheck(deadline)?;
    if Instant::now()>=deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"holder capture deadline")); }
    let mut observation=census.into_observation();
    peer_roots.bind(&mut observation)?;
    Ok((observation,candidates,store_client,peer_roots))
}
fn scope_receipt(response: &Response, receipt: &[u8]) -> Vec<u8> {
    let mut out=b"holder-evidence-scope-v1\0".to_vec();
    for value in [response.producer_id.as_str(),response.policy_id.as_str(),response.scope.requested_paths_digest.as_str(),response.host_id.as_str(),response.boot_id.as_str(),&response.capture.started_boot_ns.to_string(),&response.capture.finished_boot_ns.to_string(),&response.capture.expires_boot_ns.to_string(),response.nonce.as_str(),match response.kind {Kind::Worktree=>"worktree",Kind::Store=>"store"}] {
        out.extend_from_slice(value.as_bytes()); out.push(0);
    }
    out.extend_from_slice(receipt); out
}
fn serve_once(deadline: Instant) -> io::Result<()> {
    // Root and initial USER/PID/MNT/NET authority precede ALL candidate and
    // metadata pins. SelfRole authenticates immutable exe, '/' root/cwd and
    // socket/journal stdio; it is not an arbitrary whole-process waiver.
    let started=linux::boot_time_ns()?;
    let mut socket=linux::inherited_evidence_socket()?;
    let role=client::SelfRole::bootstrap(&socket,deadline)?;
    let uid=env!("HOLDER_EVIDENCE_UID").parse::<u32>().map_err(|_|io::Error::other("invalid compiled owner UID"))?;
    if uid==0 { return Err(io::Error::other("root is not an enrolled client")); }
    let peer=client::Peer::attest(&socket,uid,deadline)?;
    let input=transport::read_request(&mut socket,deadline)?;
    let request=Request::parse(&input,true)?;
    let namespaces=role.namespace_ids();
    if namespaces!=INITIAL_NAMESPACES { return Err(io::Error::other("noninitial server namespaces")); }
    let (host_id,boot_id)=host_identity(deadline)?;
    let paths_digest=decode::digest(request.paths_receipt(),deadline)?;
    // Keep the roots and original store/lease OFDs retained through emission.
    let (observation,_pins)=match collect(&request,&peer,&role,deadline) {
        Ok((observation,candidates,store_client,peer_roots))=>(observation,Some((candidates,store_client,peer_roots))),
        Err(error)=>{
            // Never return an absence after partial coverage. Do not leak
            // foreign argv/env or pseudo-file contents in diagnostics.
            eprintln!("worktree-holder-evidence: incomplete census ({:?})",error.kind());
            (unknown(&request,match error.kind() {io::ErrorKind::PermissionDenied=>UnknownReason::Permission,io::ErrorKind::Unsupported=>UnknownReason::Unsupported,io::ErrorKind::TimedOut=>UnknownReason::Capacity,_=>UnknownReason::ProcessIncomplete}),None)
        },
    };
    let finished=linux::boot_time_ns()?;
    let expires=started.checked_add(protocol::TTL_NS).ok_or_else(||io::Error::other("boot clock overflow"))?;
    let mut response=Response {nonce:request.nonce.clone(),kind:request.kind,producer_id:PRODUCER.into(),policy_id:POLICY.into(),host_id,boot_id,capture:Capture {started_boot_ns:started,finished_boot_ns:finished,expires_boot_ns:expires},scope:Scope {complete:observation.complete,process_count:observation.process_count,task_count:observation.task_count,namespaces,requested_paths_digest:paths_digest,digest:String::new()},roots:observation.roots};
    response.scope.digest=decode::digest(scope_receipt(&response,&observation.receipt),deadline)?;
    // Validate our own structural invariants too: a census implementation may
    // never accidentally serialize an incomplete negative or an extra root.
    response.validate(&request,PRODUCER,POLICY,&response.host_id,&response.boot_id,INITIAL_NAMESPACES,&response.scope.requested_paths_digest,linux::boot_time_ns()?)?;
    peer.recheck(deadline)?; role.recheck(deadline)?;
    transport::write_response(&mut socket,&response.serialize()?,deadline)
}
fn client_response(request: &Request, input: &[u8], deadline: Instant) -> io::Result<Response> {
    let requested_at=linux::boot_time_ns()?;
    let output=transport::exchange(input,deadline)?;
    let response=Response::parse(&output)?;
    let (host,boot)=host_identity(deadline)?;
    let paths=decode::digest(request.paths_receipt(),deadline)?;
    response.validate(request,PRODUCER,POLICY,&host,&boot,INITIAL_NAMESPACES,&paths,linux::boot_time_ns()?)?;
    if response.capture.started_boot_ns<requested_at { return Err(io::Error::other("capture predates this request")); }
    Ok(response)
}
fn worktree_client(deadline: Instant) -> io::Result<()> {
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
fn pnpm_client(arguments: impl Iterator<Item=OsString>, deadline: Instant) -> io::Result<()> {
    std::env::set_current_dir("/")?;
    let mut arguments=arguments;
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
fn run() -> io::Result<()> {
    // Fatal lifetime also bounds descendants and blocked socket/stdin reads.
    linux::bound_helper_lifetime()?;
    let deadline=Instant::now()+Duration::from_secs(25);
    let mut arguments=std::env::args_os().skip(1);
    let mode=arguments.next().ok_or_else(||io::Error::other("missing fixed helper mode"))?;
    if mode==OsStr::new("--pnpm-client-v1") { return pnpm_client(arguments,deadline); }
    if arguments.next().is_some() { return Err(io::Error::other("extra helper argument")); }
    if mode==OsStr::new("--client-v1") { worktree_client(deadline) }
    else if mode==OsStr::new("--serve-once") { serve_once(deadline) }
    else if mode==OsStr::new("--codec-fixtures-v1") {
        let mut stdout=io::stdout().lock(); for fixture in protocol::codec_fixtures()? { stdout.write_all(&fixture)?; stdout.write_all(b"\n")?; } stdout.flush()
    } else { Err(io::Error::other("unsupported helper mode")) }
}
fn main() -> ExitCode {
    match run() {
        Ok(())=>ExitCode::SUCCESS,
        Err(error)=>{eprintln!("worktree-holder-evidence: unknown ({:?})",error.kind());ExitCode::from(1)},
    }
}
