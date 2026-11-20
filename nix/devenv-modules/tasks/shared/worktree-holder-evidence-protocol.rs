//! Shared holder-evidence v1 wire authority. No filesystem or absence authority
//! follows from decoding: enrollment, authentication and freshness are mandatory.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::PathBuf;

pub const MAX_REQUEST: usize = 1024 * 1024;
pub const MAX_RESPONSE: usize = 16 * 1024 * 1024;
pub const MAX_ROOTS: usize = 4096;
pub const MAX_REFERENCES: usize = 65536;
pub const TTL_NS: u64 = 30_000_000_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Worktree, Store }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectIdentity { pub dev: u64, pub ino: u64, pub mount_id: u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceKind { Root, Cwd, Mount, Exe, Fd, Map }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceEffect { InUse, RetainedBytes }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub tgid: u32, pub leader_start: u64, pub tid: u32, pub task_start: u64,
    pub uid: [u32; 4], pub reference: ReferenceKind, pub relative_path: String,
    pub identity: ObjectIdentity, pub effect: ReferenceEffect, pub fd: Option<u32>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status { NoCurrentReference, InUse, Unknown }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownReason {
    Permission, Race, Unsupported, Capacity, RootUncovered, RootChanged,
    MountBackingUnknown, KernelObjectUnknown, ProcessIncomplete, ReferenceOverflow,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootEvidence {
    pub path: PathBuf, pub identity: Option<ObjectIdentity>, pub complete: bool,
    pub status: Status, pub references_complete: bool, pub references: Vec<Reference>,
    pub unknown_reasons: Vec<UnknownReason>,
}
pub struct Observation {
    pub complete: bool, pub process_count: u32, pub task_count: u32,
    pub roots: Vec<RootEvidence>, pub receipt: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub version: u32, pub nonce: String, pub kind: Kind, pub paths: Vec<PathBuf>,
    pub store: Option<super::request::StoreRequest>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture { pub started_boot_ns: u64, pub finished_boot_ns: u64, pub expires_boot_ns: u64 }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub complete: bool, pub process_count: u32, pub task_count: u32,
    pub namespaces: [u64; 4], pub requested_paths_digest: String, pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub nonce: String, pub kind: Kind, pub producer_id: String, pub policy_id: String,
    pub host_id: String, pub boot_id: String, pub capture: Capture, pub scope: Scope,
    pub roots: Vec<RootEvidence>,
}
fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "invalid holder-evidence v1 frame") }
pub fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn canonical_path(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 4096 && value != "/"
        && !value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
        && value[1..].split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}
fn relative_path(value: &str) -> bool {
    value == "." || (!value.is_empty() && value.len() <= 4096 && !value.starts_with('/')
        && !value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
        && value.split('/').all(|c| !c.is_empty() && c != "." && c != ".."))
}
fn kind(value: Kind) -> &'static str { match value { Kind::Worktree => "worktree", Kind::Store => "store" } }
fn parse_kind(value: &str) -> io::Result<Kind> { match value { "worktree" => Ok(Kind::Worktree), "store" => Ok(Kind::Store), _ => Err(invalid()) } }
fn reason(value: UnknownReason) -> &'static str {
    match value {
        UnknownReason::Permission => "permission", UnknownReason::Race => "race",
        UnknownReason::Unsupported => "unsupported", UnknownReason::Capacity => "capacity",
        UnknownReason::RootUncovered => "root-uncovered", UnknownReason::RootChanged => "root-changed",
        UnknownReason::MountBackingUnknown => "mount-backing-unknown", UnknownReason::KernelObjectUnknown => "kernel-object-unknown",
        UnknownReason::ProcessIncomplete => "process-incomplete", UnknownReason::ReferenceOverflow => "reference-overflow",
    }
}
fn parse_reason(value: &str) -> io::Result<UnknownReason> {
    [UnknownReason::Permission, UnknownReason::Race, UnknownReason::Unsupported, UnknownReason::Capacity,
        UnknownReason::RootUncovered, UnknownReason::RootChanged, UnknownReason::MountBackingUnknown,
        UnknownReason::KernelObjectUnknown, UnknownReason::ProcessIncomplete, UnknownReason::ReferenceOverflow]
        .into_iter().find(|r| reason(*r) == value).ok_or_else(invalid)
}

// Strict bounded JSON, including duplicate-key rejection (which a jq object
// decoder cannot provide). Numbers in this protocol are unsigned integers only.
#[derive(Debug)]
enum Json { Null, Bool(bool), Number(u64), String(String), Array(Vec<Json>), Object(BTreeMap<String, Json>) }
struct Parser<'a> { input: &'a [u8], at: usize, nodes: usize }
impl Parser<'_> {
    fn ws(&mut self) { while self.input.get(self.at).is_some_and(|b| matches!(b, b' ' | b'\n' | b'\r' | b'\t')) { self.at += 1; } }
    fn byte(&mut self, expected: u8) -> io::Result<()> {
        if self.input.get(self.at) != Some(&expected) { return Err(invalid()); }
        self.at += 1; Ok(())
    }
    fn string(&mut self) -> io::Result<String> {
        self.byte(b'"')?;
        let mut out = Vec::new();
        loop {
            let b = *self.input.get(self.at).ok_or_else(invalid)?; self.at += 1;
            match b {
                b'"' => return String::from_utf8(out).map_err(|_| invalid()),
                0..=31 => return Err(invalid()),
                b'\\' => {
                    let escape = *self.input.get(self.at).ok_or_else(invalid)?; self.at += 1;
                    match escape {
                        b'"' | b'\\' | b'/' => out.push(escape), b'b' => out.push(8), b'f' => out.push(12),
                        b'n' => out.push(b'\n'), b'r' => out.push(b'\r'), b't' => out.push(b'\t'),
                        b'u' => {
                            let first = self.code_unit()?;
                            let scalar = if (0xd800..=0xdbff).contains(&first) {
                                self.byte(b'\\')?; self.byte(b'u')?;
                                let second = self.code_unit()?;
                                if !(0xdc00..=0xdfff).contains(&second) { return Err(invalid()); }
                                0x10000 + ((first - 0xd800) << 10) + second - 0xdc00
                            } else { first };
                            let c = char::from_u32(scalar).ok_or_else(invalid)?;
                            out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                        }, _ => return Err(invalid()),
                    }
                }, _ => out.push(b),
            }
        }
    }
    fn code_unit(&mut self) -> io::Result<u32> {
        let mut n = 0;
        for _ in 0..4 {
            let b = *self.input.get(self.at).ok_or_else(invalid)?; self.at += 1;
            n = n * 16 + match b { b'0'..=b'9' => u32::from(b-b'0'), b'a'..=b'f' => u32::from(b-b'a'+10), b'A'..=b'F' => u32::from(b-b'A'+10), _ => return Err(invalid()) };
        }
        Ok(n)
    }
    fn value(&mut self, depth: usize) -> io::Result<Json> {
        self.nodes += 1;
        if depth > 16 || self.nodes > 2_000_000 { return Err(invalid()); }
        self.ws();
        match self.input.get(self.at).copied().ok_or_else(invalid)? {
            b'"' => self.string().map(Json::String),
            b'{' => {
                self.at += 1; self.ws(); let mut values = BTreeMap::new();
                if self.input.get(self.at) == Some(&b'}') { self.at += 1; return Ok(Json::Object(values)); }
                loop {
                    self.ws(); let key = self.string()?; self.ws(); self.byte(b':')?;
                    let value = self.value(depth+1)?;
                    if values.insert(key, value).is_some() { return Err(invalid()); }
                    self.ws(); if self.input.get(self.at) == Some(&b'}') { self.at += 1; break; }
                    self.byte(b',')?;
                }
                Ok(Json::Object(values))
            },
            b'[' => {
                self.at += 1; self.ws(); let mut values = Vec::new();
                if self.input.get(self.at) == Some(&b']') { self.at += 1; return Ok(Json::Array(values)); }
                loop {
                    values.push(self.value(depth+1)?); self.ws();
                    if self.input.get(self.at) == Some(&b']') { self.at += 1; break; }
                    self.byte(b',')?;
                }
                Ok(Json::Array(values))
            },
            b'0'..=b'9' => {
                let start = self.at;
                while self.input.get(self.at).is_some_and(u8::is_ascii_digit) { self.at += 1; }
                let text = std::str::from_utf8(&self.input[start..self.at]).map_err(|_| invalid())?;
                Ok(Json::Number(decimal(text)?))
            },
            b't' | b'f' | b'n' => {
                for (word, value) in [(b"true".as_slice(), Json::Bool(true)), (b"false".as_slice(), Json::Bool(false)), (b"null".as_slice(), Json::Null)] {
                    if self.input[self.at..].starts_with(word) { self.at += word.len(); return Ok(value); }
                }
                Err(invalid())
            }, _ => Err(invalid()),
        }
    }
}
fn json(input: &[u8], limit: usize) -> io::Result<Json> {
    if input.is_empty() || input.len() > limit { return Err(invalid()); }
    let mut parser = Parser { input, at: 0, nodes: 0 };
    let result = parser.value(0)?; parser.ws();
    if parser.at != input.len() { return Err(invalid()); }
    Ok(result)
}
fn decimal(s: &str) -> io::Result<u64> {
    if s.is_empty() || s.len() > 20 || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit()) { return Err(invalid()); }
    s.parse().map_err(|_| invalid())
}
fn object(j: Json) -> io::Result<BTreeMap<String, Json>> { if let Json::Object(v) = j { Ok(v) } else { Err(invalid()) } }
fn take(o: &mut BTreeMap<String, Json>, name: &str) -> io::Result<Json> { o.remove(name).ok_or_else(invalid) }
fn done(o: BTreeMap<String, Json>) -> io::Result<()> { if o.is_empty() { Ok(()) } else { Err(invalid()) } }
fn string(j: Json) -> io::Result<String> { if let Json::String(v) = j { Ok(v) } else { Err(invalid()) } }
fn boolean(j: Json) -> io::Result<bool> { if let Json::Bool(v) = j { Ok(v) } else { Err(invalid()) } }
fn number(j: Json) -> io::Result<u32> { if let Json::Number(v) = j { u32::try_from(v).map_err(|_| invalid()) } else { Err(invalid()) } }
fn dec(j: Json) -> io::Result<u64> { decimal(&string(j)?) }
fn array(j: Json) -> io::Result<Vec<Json>> { if let Json::Array(v) = j { Ok(v) } else { Err(invalid()) } }
fn text(o: &mut BTreeMap<String, Json>, key: &str) -> io::Result<String> { string(take(o, key)?) }
fn quoted(out: &mut String, s: &str) {
    use std::fmt::Write;
    out.push('"');
    for c in s.chars() {
        match c { '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"), '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"), c if c < ' ' => { write!(out, "\\u{:04x}", u32::from(c)).expect("String write"); }, c => out.push(c) }
    }
    out.push('"');
}
fn pair(out: &mut String, key: &str, value: &str) { quoted(out, key); out.push(':'); quoted(out, value); }
fn decimal_pair(out: &mut String, key: &str, value: u64) {
    use std::fmt::Write;
    quoted(out,key); write!(out,":\"{value}\"").expect("String write");
}
fn identity(out: &mut String, value: &ObjectIdentity) {
    out.push('{'); decimal_pair(out, "dev", value.dev); out.push(','); decimal_pair(out, "ino", value.ino);
    out.push(','); decimal_pair(out, "mountId", value.mount_id); out.push('}');
}
fn read_identity(j: Json) -> io::Result<ObjectIdentity> {
    let mut o = object(j)?;
    let result = ObjectIdentity { dev: dec(take(&mut o,"dev")?)?, ino: dec(take(&mut o,"ino")?)?, mount_id: dec(take(&mut o,"mountId")?)? };
    done(o)?;
    if result.ino == 0 || result.mount_id == 0 { return Err(invalid()); } Ok(result)
}
impl Request {
    pub fn parse(input: &[u8], allow_store: bool) -> io::Result<Self> {
        let mut o = object(json(input, MAX_REQUEST)?)?;
        let version = number(take(&mut o, "version")?)?;
        let nonce = text(&mut o, "nonce")?; let kind = parse_kind(&text(&mut o,"kind")?)?;
        let paths = array(take(&mut o,"paths")?)?.into_iter().map(|j| string(j).map(PathBuf::from)).collect::<io::Result<Vec<_>>>()?;
        let store = if kind == Kind::Store && allow_store {
            let mut s = object(take(&mut o,"store")?)?;
            let fields = [paths.first().and_then(|p| p.to_str()).ok_or_else(invalid)?.to_owned(),
                dec(take(&mut s,"dev")?)?.to_string(), dec(take(&mut s,"ino")?)?.to_string(),
                number(take(&mut s,"rootFd")?)?.to_string(), number(take(&mut s,"leaseFd")?)?.to_string(), nonce.clone(),
                dec(take(&mut s,"clientStart")?)?.to_string()];
            done(s)?;
            Some(super::request::StoreRequest::parse(fields.into_iter().map(Into::into)).map_err(io::Error::other)?)
        } else { None };
        done(o)?;
        let request = Self { version, nonce, kind, paths, store }; request.validate()?; Ok(request)
    }
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1 || !hex(&self.nonce,32) || self.paths.is_empty() || self.paths.len() > MAX_ROOTS { return Err(invalid()); }
        let mut seen = BTreeSet::new();
        for p in &self.paths { let s = p.to_str().ok_or_else(invalid)?; if !canonical_path(s) || !seen.insert(s) { return Err(invalid()); } }
        match (&self.kind, &self.store) {
            (Kind::Worktree,None) => {},
            (Kind::Store,Some(s)) if self.paths.len() == 1 && self.paths[0] == s.candidate && self.nonce == s.nonce => {},
            _ => return Err(invalid()),
        }
        Ok(())
    }
    pub fn serialize(&self) -> io::Result<Vec<u8>> {
        use std::fmt::Write;
        self.validate()?;
        let mut out = String::from("{\"version\":1,"); pair(&mut out,"nonce",&self.nonce); out.push(','); pair(&mut out,"kind",kind(self.kind));
        out.push_str(",\"paths\":[");
        for (i,p) in self.paths.iter().enumerate() { if i>0 { out.push(','); } quoted(&mut out,p.to_str().ok_or_else(invalid)?); }
        out.push(']');
        if let Some(s) = &self.store {
            out.push_str(",\"store\":{"); decimal_pair(&mut out,"dev",s.device); out.push(','); decimal_pair(&mut out,"ino",s.inode);
            write!(out,",\"rootFd\":{},\"leaseFd\":{},",s.root_fd,s.lease_fd).expect("String write");
            decimal_pair(&mut out,"clientStart",s.client_start); out.push('}');
        }
        out.push('}'); if out.len()>MAX_REQUEST { return Err(invalid()); } Ok(out.into_bytes())
    }
    /// Frozen v1 ordered path digest input; canonical paths cannot contain NUL.
    pub fn paths_receipt(&self) -> Vec<u8> {
        let mut out = b"holder-evidence-paths-v1\0".to_vec();
        out.extend_from_slice(kind(self.kind).as_bytes()); out.push(0);
        for p in &self.paths { out.extend_from_slice(p.as_os_str().as_encoded_bytes()); out.push(0); }
        out
    }
}
impl Response {
    pub fn serialize(&self) -> io::Result<Vec<u8>> {
        use std::fmt::Write;
        let mut out = String::from("{\"version\":1,");
        for (i,(key,value)) in [("nonce",self.nonce.as_str()),("kind",kind(self.kind)),("producerId",&self.producer_id),("policyId",&self.policy_id),("model","managed-cooperative-v1"),("hostId",&self.host_id),("bootId",&self.boot_id)].into_iter().enumerate() { if i>0 { out.push(','); } pair(&mut out,key,value); }
        out.push_str(",\"capture\":{"); decimal_pair(&mut out,"startedBootNs",self.capture.started_boot_ns); out.push(',');
        decimal_pair(&mut out,"finishedBootNs",self.capture.finished_boot_ns); out.push(','); decimal_pair(&mut out,"expiresBootNs",self.capture.expires_boot_ns);
        write!(out,"}},\"scope\":{{\"complete\":{},\"allUids\":true,\"allTasks\":true,\"processCount\":{},\"taskCount\":{},\"namespaces\":{{",self.scope.complete,self.scope.process_count,self.scope.task_count).expect("String write");
        for (i,key) in ["user","pid","mnt","net"].into_iter().enumerate() { if i>0 { out.push(','); } decimal_pair(&mut out,key,self.scope.namespaces[i]); }
        out.push_str("},"); pair(&mut out,"requestedPathsDigest",&self.scope.requested_paths_digest); out.push(','); pair(&mut out,"digest",&self.scope.digest);
        out.push_str("},\"roots\":[");
        for (i,r) in self.roots.iter().enumerate() {
            if i>0 { out.push(','); } out.push('{'); pair(&mut out,"path",r.path.to_str().ok_or_else(invalid)?);
            out.push_str(",\"identity\":"); if let Some(id)=&r.identity { identity(&mut out,id); } else { out.push_str("null"); }
            write!(out,",\"complete\":{},",r.complete).expect("String write");
            pair(&mut out,"status",match r.status { Status::NoCurrentReference=>"no-current-reference",Status::InUse=>"in-use",Status::Unknown=>"unknown" });
            write!(out,",\"referencesComplete\":{},\"references\":[",r.references_complete).expect("String write");
            for (j,h) in r.references.iter().enumerate() {
                if j>0 { out.push(','); }
                write!(out,"{{\"tgid\":{},\"leaderStart\":\"{}\",\"tid\":{},\"taskStart\":\"{}\",\"uid\":[{},{},{},{}],",h.tgid,h.leader_start,h.tid,h.task_start,h.uid[0],h.uid[1],h.uid[2],h.uid[3]).expect("String write");
                pair(&mut out,"reference",match h.reference {ReferenceKind::Root=>"root",ReferenceKind::Cwd=>"cwd",ReferenceKind::Mount=>"mount",ReferenceKind::Exe=>"exe",ReferenceKind::Fd=>"fd",ReferenceKind::Map=>"map"});
                out.push(','); pair(&mut out,"relativePath",&h.relative_path); out.push_str(",\"identity\":"); identity(&mut out,&h.identity); out.push(',');
                pair(&mut out,"effect",match h.effect {ReferenceEffect::InUse=>"in-use",ReferenceEffect::RetainedBytes=>"retained-bytes"});
                out.push_str(",\"fd\":"); if let Some(fd)=h.fd { write!(out,"{fd}").expect("String write"); } else { out.push_str("null"); } out.push('}');
            }
            out.push_str("],\"unknownReasons\":["); for (j,cause) in r.unknown_reasons.iter().enumerate() { if j>0 { out.push(','); } quoted(&mut out,reason(*cause)); } out.push_str("]}");
            if out.len()>MAX_RESPONSE { return Err(invalid()); }
        }
        out.push_str("]}"); if out.len()>MAX_RESPONSE { return Err(invalid()); } Ok(out.into_bytes())
    }
    pub fn parse(input: &[u8]) -> io::Result<Self> {
        let mut o = object(json(input,MAX_RESPONSE)?)?;
        if number(take(&mut o,"version")?)? != 1 || text(&mut o,"model")? != "managed-cooperative-v1" { return Err(invalid()); }
        let nonce=text(&mut o,"nonce")?; let kind=parse_kind(&text(&mut o,"kind")?)?;
        let producer_id=text(&mut o,"producerId")?; let policy_id=text(&mut o,"policyId")?;
        let host_id=text(&mut o,"hostId")?; let boot_id=text(&mut o,"bootId")?;
        let mut c=object(take(&mut o,"capture")?)?;
        let capture=Capture {started_boot_ns:dec(take(&mut c,"startedBootNs")?)?,finished_boot_ns:dec(take(&mut c,"finishedBootNs")?)?,expires_boot_ns:dec(take(&mut c,"expiresBootNs")?)?}; done(c)?;
        let mut s=object(take(&mut o,"scope")?)?;
        if !boolean(take(&mut s,"allUids")?)? || !boolean(take(&mut s,"allTasks")?)? { return Err(invalid()); }
        let complete=boolean(take(&mut s,"complete")?)?; let process_count=number(take(&mut s,"processCount")?)?; let task_count=number(take(&mut s,"taskCount")?)?;
        let mut ns=object(take(&mut s,"namespaces")?)?; let mut namespaces=[0;4];
        for (i,key) in ["user","pid","mnt","net"].into_iter().enumerate() { namespaces[i]=dec(take(&mut ns,key)?)?; } done(ns)?;
        let scope=Scope {complete,process_count,task_count,namespaces,requested_paths_digest:text(&mut s,"requestedPathsDigest")?,digest:text(&mut s,"digest")?}; done(s)?;
        let roots=array(take(&mut o,"roots")?)?.into_iter().map(read_root).collect::<io::Result<Vec<_>>>()?; done(o)?;
        Ok(Self {nonce,kind,producer_id,policy_id,host_id,boot_id,capture,scope,roots})
    }
    pub fn validate(&self, request: &Request, producer: &str, policy: &str, host: &str, boot: &str, namespaces: [u64;4], paths_digest: &str, now: u64) -> io::Result<()> {
        request.validate()?;
        let c=&self.capture;
        if self.nonce!=request.nonce || self.kind!=request.kind || self.producer_id!=producer || self.producer_id.is_empty()
            || self.policy_id!=policy || !hex(&self.policy_id,64) || self.host_id!=host || !hex(&self.host_id,64)
            || self.boot_id!=boot || self.scope.namespaces!=namespaces || self.scope.namespaces.contains(&0)
            || self.scope.requested_paths_digest!=paths_digest || !hex(paths_digest,64) || !hex(&self.scope.digest,64)
            || c.started_boot_ns>c.finished_boot_ns || c.finished_boot_ns>now || now>=c.expires_boot_ns
            || c.finished_boot_ns-c.started_boot_ns>25_000_000_000 || c.started_boot_ns.checked_add(TTL_NS)!=Some(c.expires_boot_ns)
            || self.roots.len()!=request.paths.len() || self.scope.process_count>self.scope.task_count { return Err(invalid()); }
        let mut total=0;
        for (r,path) in self.roots.iter().zip(&request.paths) {
            total+=r.references.len();
            if &r.path!=path || r.references.len()>4096 || total>MAX_REFERENCES
                || r.identity.as_ref().is_some_and(|id| id.ino==0 || id.mount_id==0)
                || (r.complete && (r.identity.is_none() || !r.unknown_reasons.is_empty()))
                || (r.status==Status::NoCurrentReference && (!self.scope.complete || !r.complete || !r.references_complete || r.references.iter().any(|h| h.effect==ReferenceEffect::InUse)))
                || (r.status==Status::InUse && !r.references.iter().any(|h| h.effect==ReferenceEffect::InUse)) { return Err(invalid()); }
            for h in &r.references {
                if h.tgid==0 || h.tid==0 || h.leader_start==0 || h.task_start==0 || !relative_path(&h.relative_path)
                    || h.identity.ino==0 || h.identity.mount_id==0 || (h.reference==ReferenceKind::Fd)!=h.fd.is_some()
                    || (h.effect==ReferenceEffect::RetainedBytes && matches!(h.reference,ReferenceKind::Root|ReferenceKind::Cwd|ReferenceKind::Mount)) { return Err(invalid()); }
            }
        }
        Ok(())
    }
}
fn read_root(j: Json) -> io::Result<RootEvidence> {
    let mut o=object(j)?; let path=PathBuf::from(text(&mut o,"path")?);
    let identity=match take(&mut o,"identity")? { Json::Null=>None,j=>Some(read_identity(j)?) };
    let complete=boolean(take(&mut o,"complete")?)?;
    let status=match text(&mut o,"status")?.as_str() { "no-current-reference"=>Status::NoCurrentReference,"in-use"=>Status::InUse,"unknown"=>Status::Unknown,_=>return Err(invalid()) };
    let references_complete=boolean(take(&mut o,"referencesComplete")?)?;
    let references=array(take(&mut o,"references")?)?.into_iter().map(read_reference).collect::<io::Result<Vec<_>>>()?;
    let unknown_reasons=array(take(&mut o,"unknownReasons")?)?.into_iter().map(|j|parse_reason(&string(j)?)).collect::<io::Result<Vec<_>>>()?; done(o)?;
    Ok(RootEvidence {path,identity,complete,status,references_complete,references,unknown_reasons})
}
fn read_reference(j: Json) -> io::Result<Reference> {
    let mut o=object(j)?; let tgid=number(take(&mut o,"tgid")?)?; let leader_start=dec(take(&mut o,"leaderStart")?)?;
    let tid=number(take(&mut o,"tid")?)?; let task_start=dec(take(&mut o,"taskStart")?)?;
    let uid=array(take(&mut o,"uid")?)?.into_iter().map(number).collect::<io::Result<Vec<_>>>()?.try_into().map_err(|_|invalid())?;
    let reference=match text(&mut o,"reference")?.as_str() {"root"=>ReferenceKind::Root,"cwd"=>ReferenceKind::Cwd,"mount"=>ReferenceKind::Mount,"exe"=>ReferenceKind::Exe,"fd"=>ReferenceKind::Fd,"map"=>ReferenceKind::Map,_=>return Err(invalid())};
    let relative_path=text(&mut o,"relativePath")?; let identity=read_identity(take(&mut o,"identity")?)?;
    let effect=match text(&mut o,"effect")?.as_str() {"in-use"=>ReferenceEffect::InUse,"retained-bytes"=>ReferenceEffect::RetainedBytes,_=>return Err(invalid())};
    let fd=match take(&mut o,"fd")? { Json::Null=>None,j=>Some(number(j)?) }; done(o)?;
    Ok(Reference {tgid,leader_start,tid,task_start,uid,reference,relative_path,identity,effect,fd})
}

/// Synthetic codec data, NOT a live census or a production qualification.
/// JSONL order: clear, cwd, fd, map, incomplete-positive, mixed covered roots,
/// exact threaded-daemon lifetime, retained-byte fd/map/exe, null/uncovered root.
pub fn codec_fixtures() -> io::Result<Vec<Vec<u8>>> {
    use std::time::{Duration,Instant};
    let deadline=Instant::now()+Duration::from_secs(1);
    let id=ObjectIdentity {dev:8,ino:9,mount_id:10};
    let root=RootEvidence {path:"/srv/worktrees/fixture".into(),identity:Some(id.clone()),complete:true,status:Status::NoCurrentReference,references_complete:true,references:vec![],unknown_reasons:vec![]};
    let holder=Reference {tgid:41,leader_start:100,tid:42,task_start:101,uid:[1000;4],reference:ReferenceKind::Cwd,relative_path:".".into(),identity:id,effect:ReferenceEffect::InUse,fd:None};
    let mut unknown=root.clone();
    unknown.identity=None; unknown.complete=false; unknown.status=Status::Unknown;
    unknown.references_complete=false; unknown.unknown_reasons.push(UnknownReason::RootUncovered);
    let mut result=Vec::new();
    for case in 0..9 {
        let mut roots=vec![root.clone()]; let mut complete=true;
        match case {
            0=>{},
            1..=4 | 6=>{
                let mut reference=holder.clone();
                if case==2 {reference.reference=ReferenceKind::Fd;reference.fd=Some(7);}
                if case==3 {reference.reference=ReferenceKind::Map;reference.relative_path="lib/payload".into();}
                if case==6 {reference.tgid=123;reference.leader_start=456;reference.tid=124;reference.task_start=457;}
                roots[0].status=Status::InUse; roots[0].references.push(reference);
                if case==1 {
                    let mut mounted=holder.clone();mounted.reference=ReferenceKind::Mount;
                    mounted.relative_path="lib/mounted".into();roots[0].references.push(mounted);
                }
                if case==4 {
                    complete=false;roots[0].complete=false;roots[0].references_complete=false;
                    roots[0].unknown_reasons.push(UnknownReason::ReferenceOverflow);
                }
            },
            5=>{let mut other=unknown.clone();other.path="/srv/worktrees/uncovered".into();roots.push(other);},
            7=>{
                for kind in [ReferenceKind::Fd,ReferenceKind::Map,ReferenceKind::Exe] {
                    let mut reference=holder.clone();reference.reference=kind;
                    reference.fd=if kind==ReferenceKind::Fd {Some(8)} else {None};
                    reference.relative_path="lib/retained".into();reference.effect=ReferenceEffect::RetainedBytes;
                    roots[0].references.push(reference);
                }
            },
            _=>{roots[0]=unknown.clone();complete=false;},
        }
        let request=Request {version:1,nonce:"0123456789abcdef0123456789abcdef".into(),kind:Kind::Worktree,paths:roots.iter().map(|r|r.path.clone()).collect(),store:None};
        let requested_paths_digest=super::digest::digest(request.paths_receipt(),deadline)?;
        let response=Response {
            nonce:request.nonce.clone(),kind:request.kind,
            producer_id:"/nix/store/00000000000000000000000000000000-holder-evidence-codec-fixture".into(),
            policy_id:"a".repeat(64),host_id:"b".repeat(64),boot_id:"00000000-0000-4000-8000-000000000001".into(),
            capture:Capture {started_boot_ns:1_000_000_000,finished_boot_ns:2_000_000_000,expires_boot_ns:31_000_000_000},
            scope:Scope {complete,process_count:1,task_count:2,namespaces:[4026531837,4026531836,4026531832,4026531833],requested_paths_digest,digest:"d".repeat(64)},
            roots,
        };
        result.push(response.serialize()?);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request { Request {version:1,nonce:"0123456789abcdef0123456789abcdef".into(),kind:Kind::Worktree,paths:vec!["/srv/worktrees/fixture".into()],store:None} }
    #[test]
    fn strict_request_roundtrip_and_rejections() {
        let r=request(); assert_eq!(Request::parse(&r.serialize().unwrap(),false).unwrap(),r);
        for input in [r#"{"version":1,"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a"]}"#, r#"{"version":2,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a"]}"#, r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a","/a"]}"#, r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a/../b"]}"#] { assert!(Request::parse(input.as_bytes(),false).is_err()); }
        assert!(Request::parse(&vec![b' ';MAX_REQUEST+1],false).is_err());
    }
    #[test]
    fn store_adapter_roundtrip_never_becomes_generic_worktree_input() {
        let fields=["/srv/worktrees/fixture/.devenv/pnpm-store-pure-v1","8","9","7","8","0123456789abcdef0123456789abcdef","456"];
        let store=super::super::request::StoreRequest::parse(fields.into_iter().map(Into::into)).unwrap();
        let r=Request {version:1,nonce:store.nonce.clone(),kind:Kind::Store,paths:vec![store.candidate.clone()],store:Some(store)};
        let bytes=r.serialize().unwrap();
        assert_eq!(Request::parse(&bytes,true).unwrap(),r);
        assert!(Request::parse(&bytes,false).is_err());
        let mut wrong=r.clone();wrong.paths.push("/srv/worktrees/other".into());assert!(wrong.serialize().is_err());
        let mut wrong=r;wrong.kind=Kind::Worktree;assert!(wrong.serialize().is_err());
    }
    #[test]
    fn full_mebibyte_request_and_exact_ordered_digest_input() {
        let r=request(); let mut bytes=r.serialize().unwrap();
        bytes.resize(MAX_REQUEST,b' ');
        assert_eq!(Request::parse(&bytes,false).unwrap(),r);
        bytes.push(b' '); assert!(Request::parse(&bytes,false).is_err());
        assert_eq!(r.paths_receipt(),b"holder-evidence-paths-v1\0worktree\0/srv/worktrees/fixture\0");
        let mut two=r.clone(); two.paths.push("/srv/worktrees/second".into());
        let receipt=two.paths_receipt(); two.paths.reverse(); assert_ne!(two.paths_receipt(),receipt);
        let mut many=r; many.paths=(0..MAX_ROOTS).map(|i|PathBuf::from(format!("/srv/worktrees/{i}"))).collect();
        Request::parse(&many.serialize().unwrap(),false).unwrap();
        many.paths.push("/srv/worktrees/overflow".into()); assert!(many.serialize().is_err());
    }
    #[test]
    fn strict_json_escapes_types_and_unknown_fields() {
        for input in [
            r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a"],"extra":null}"#,
            r#"{"version":"1","nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a"]}"#,
            r#"{"version":01,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a"]}"#,
            r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a\u0000b"]}"#,
            r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a\ud800"]}"#,
            r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"store","paths":["/a"]}"#,
        ] { assert!(Request::parse(input.as_bytes(),false).is_err()); }
        let unicode=r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","kind":"worktree","paths":["/a\ud801\udc00"]}"#;
        assert_eq!(Request::parse(unicode.as_bytes(),false).unwrap().paths,[PathBuf::from("/a\u{10400}")]);
    }
    #[test]
    fn rust_fixture_roundtrip_and_freshness() {
        for bytes in codec_fixtures().unwrap() {
            let r=Response::parse(&bytes).unwrap(); assert_eq!(r.serialize().unwrap(),bytes);
            let mut req=request();req.paths=r.roots.iter().map(|root|root.path.clone()).collect();
            let paths=super::super::digest::digest(req.paths_receipt(),std::time::Instant::now()+std::time::Duration::from_secs(1)).unwrap();
            let valid=|r:&Response,now|r.validate(&req,"/nix/store/00000000000000000000000000000000-holder-evidence-codec-fixture",&"a".repeat(64),&"b".repeat(64),"00000000-0000-4000-8000-000000000001",[4026531837,4026531836,4026531832,4026531833],&paths,now);
            valid(&r,3_000_000_000).unwrap(); assert!(valid(&r,31_000_000_000).is_err());
            let mut wrong=r.clone(); wrong.nonce="f".repeat(32); assert!(valid(&wrong,3_000_000_000).is_err());
            let mut wrong=r.clone(); wrong.roots.clear(); assert!(valid(&wrong,3_000_000_000).is_err());
            let mut wrong=r.clone(); wrong.scope.complete=false; wrong.roots[0].status=Status::NoCurrentReference; assert!(valid(&wrong,3_000_000_000).is_err());
            for change in 0..9 {
                let mut wrong=r.clone();
                match change {
                    0=>wrong.producer_id.push('x'), 1=>wrong.policy_id="e".repeat(64),
                    2=>wrong.host_id="e".repeat(64), 3=>wrong.scope.namespaces[0]+=1,
                    4=>wrong.scope.requested_paths_digest="e".repeat(64),
                    5=>wrong.capture.expires_boot_ns+=1, 6=>wrong.capture.finished_boot_ns=32_000_000_000,
                    7=>wrong.roots[0].path="/srv/worktrees/unrequested".into(),
                    _=>wrong.kind=Kind::Store,
                }
                assert!(valid(&wrong,3_000_000_000).is_err());
            }
            if let Some(holder)=r.roots[0].references.first() {
                let mut wrong=r.clone();wrong.roots[0].references=vec![holder.clone();4097];
                assert!(valid(&wrong,3_000_000_000).is_err());
                for kind in [ReferenceKind::Root,ReferenceKind::Cwd,ReferenceKind::Mount] {
                    let mut wrong=r.clone();
                    wrong.scope.complete=true;
                    let root=&mut wrong.roots[0];
                    root.complete=true;root.references_complete=true;
                    root.unknown_reasons.clear();root.status=Status::NoCurrentReference;
                    let mut reference=holder.clone();
                    reference.reference=kind;reference.fd=None;
                    reference.effect=ReferenceEffect::RetainedBytes;
                    root.references=vec![reference];
                    assert!(valid(&wrong,3_000_000_000).is_err());
                }
            }
        }
    }
}
