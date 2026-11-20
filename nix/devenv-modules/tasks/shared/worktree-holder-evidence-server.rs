//! Fixed-policy server, with same-binary client modes compiled only by the client package.
#![deny(unsafe_code)]
#[cfg(not(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
compile_error!("holder evidence server requires Linux x86_64 or aarch64");
use holder_evidence_protocol::{protocol, request, digest};
use worktree_holder_proc::objects;
use holder_evidence_mounted::{mounts, candidates};
#[allow(unsafe_code)]
#[path = "worktree-holder-evidence-privileged-syscalls.rs"]
mod linux;
#[path = "worktree-holder-evidence-server-auth.rs"]
mod client;
#[path = "worktree-holder-evidence-server-decode.rs"]
mod decode;
#[path = "worktree-holder-evidence-server-census.rs"]
mod census;
#[path = "worktree-holder-evidence-server-transport.rs"]
mod transport;
#[path = "worktree-holder-evidence-listener.rs"]
mod listener;
#[path = "worktree-holder-evidence-daemon.rs"]
mod daemon;
#[path = "worktree-holder-evidence-server-host-ipc.rs"]
mod host_ipc;
#[path = "worktree-holder-evidence-runtime.rs"]
mod runtime;
#[cfg(holder_evidence_clients)]
#[path = "worktree-holder-evidence-cli-client.rs"]
mod cli_client;
#[cfg(holder_evidence_clients)]
#[path = "worktree-holder-evidence-client-transport.rs"]
mod client_transport;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read};
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
    let host=digest::digest(machine,deadline)?;
    let boot=bounded_input(File::open("/proc/sys/kernel/random/boot_id")?,37)?;
    let boot=std::str::from_utf8(&boot).map_err(|_|io::Error::other("invalid boot identity"))?;
    let boot=boot.strip_suffix('\n').ok_or_else(||io::Error::other("invalid boot identity"))?;
    if boot.len()!=36 || !boot.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i) {b==b'-'} else {b.is_ascii_digit()||(b'a'..=b'f').contains(&b)}) { return Err(io::Error::other("invalid boot identity")); }
    Ok((host,boot.to_owned()))
}
fn unknown(request: &Request, cause: UnknownReason) -> Observation {
    Observation {complete:false,process_count:0,task_count:0,receipt:b"incomplete-holder-observation-v1\0".to_vec(),roots:request.paths.iter().map(|path|RootEvidence {path:path.clone(),identity:None,complete:false,status:Status::Unknown,references_complete:false,references:Vec::new(),unknown_reasons:vec![cause]}).collect()}
}
// Diagnostics never format the underlying error: it can contain foreign paths.
// Static stage, error kind and errno preserve the conservative error unchanged.
fn collect_step<T>(stage: &'static str, result: io::Result<T>) -> io::Result<T> {
    if let Err(error) = &result {
        eprintln!("worktree-holder-evidence: census stage={stage} kind={:?} errno={:?}",
            error.kind(), error.raw_os_error());
    }
    result
}
fn collect(request: &Request, peer: &client::Peer, role: &client::SelfRole, deadline: Instant) -> io::Result<(Observation,candidates::CandidateSet,Option<client::Client>,client::PeerRoots)> {
    let candidates=collect_step("candidate-pin",candidates::CandidateSet::pin(request,peer.uid,deadline))?;
    let peer_roots=collect_step("peer-root-pin",client::PeerRoots::pin(peer,&candidates,deadline))?;
    // Store pinning opens roots only. Inventory starts ONLY after the original
    // collector's root and EX FLOCK OFDs have been authenticated and retained.
    let store_client=match &request.store {
        Some(store)=>Some(collect_step("store-attest",client::Client::attest_from_peer(peer,store,peer.uid,peer_roots.root(0)))?),
        None=>None,
    };
    let census=collect_step("census-capture",census::Census::collect(request,&candidates,store_client.as_ref(),peer,role,deadline))?;
    collect_step("census-recheck",census.recheck(&candidates,store_client.as_ref(),deadline))?;
    collect_step("candidate-recheck",candidates.recheck(deadline))?;
    collect_step("peer-root-recheck",peer_roots.recheck(peer,deadline))?;
    if let (Some(client),Some(store))=(&store_client,&request.store) { collect_step("store-recheck",client.recheck(store))?; }
    collect_step("peer-recheck",peer.recheck(deadline))?;
    collect_step("server-role-recheck",role.recheck(deadline))?;
    if Instant::now()>=deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"holder capture deadline")); }
    let mut observation=census.into_observation();
    collect_step("peer-root-bind",peer_roots.bind(&mut observation))?;
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
    let paths_digest=digest::digest(request.paths_receipt(),deadline)?;
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
    response.scope.digest=digest::digest(scope_receipt(&response,&observation.receipt),deadline)?;
    // Validate our own structural invariants too: a census implementation may
    // never accidentally serialize an incomplete negative or an extra root.
    response.validate(&request,PRODUCER,POLICY,&response.host_id,&response.boot_id,INITIAL_NAMESPACES,&response.scope.requested_paths_digest,linux::boot_time_ns()?)?;
    peer.recheck(deadline)?; role.recheck(deadline)?;
    transport::write_response(&mut socket,&response.serialize()?,deadline)
}
fn run() -> io::Result<()> {
    linux::bound_helper_lifetime()?;
    let deadline=Instant::now()+Duration::from_secs(25);
    let mut arguments=std::env::args_os().skip(1);
    let mode=arguments.next();
    #[cfg(holder_evidence_clients)]
    if mode.as_deref()==Some(OsStr::new("--pnpm-client-v1")) {
        return cli_client::store_client(deadline);
    }
    if arguments.next().is_some() {
        return Err(io::Error::other("unexpected holder-evidence arguments"));
    }
    match mode.as_deref() {
        Some(mode) if mode==OsStr::new("--serve-once")=>serve_once(deadline),
        #[cfg(holder_evidence_clients)]
        Some(mode) if mode==OsStr::new("--client-v1")=>cli_client::worktree_client(deadline),
        _=>Err(io::Error::other("unsupported holder-evidence mode")),
    }
}
fn main() -> ExitCode {
    match run() {
        Ok(())=>ExitCode::SUCCESS,
        Err(error)=>{eprintln!("worktree-holder-evidence: unknown ({:?})",error.kind());ExitCode::from(1)},
    }
}
#[cfg(test)]
mod census_diagnostic_tests {
    use super::collect_step;
    use std::io;

    #[test]
    fn stage_diagnostics_preserve_success_and_original_errors() {
        assert_eq!(collect_step("test-success", Ok(37)).unwrap(), 37);
        let error = collect_step::<()>("test-errno", Err(io::Error::from_raw_os_error(13)))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.raw_os_error(), Some(13));
        let error = collect_step::<()>("test-other", Err(io::Error::other("private detail")))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(error.to_string(), "private detail");
    }
}
