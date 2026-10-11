use std::collections::BTreeMap;
use std::ffi::OsStr;

use crate::tailnet::Status;
use clap::CommandFactory;
use clap_complete::CompletionCandidate;

pub fn activate() {
    let bin = std::env::args_os()
        .next()
        .and_then(|arg| std::path::Path::new(&arg).file_name().map(OsStr::to_owned))
        .map_or_else(
            || "pingping".to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
    clap_complete::CompleteEnv::with_factory(crate::Cli::command)
        .bin(bin)
        .complete();
}

pub fn host_candidates(current: &OsStr) -> Vec<CompletionCandidate> {
    let Some(prefix) = current.to_str().filter(|value| !value.starts_with('-')) else {
        return Vec::new();
    };
    crate::tailnet::status().map_or_else(Vec::new, |status| candidates(&status, prefix))
}

fn candidates(status: &Status, prefix: &str) -> Vec<CompletionCandidate> {
    let mut hosts = BTreeMap::<String, (u8, &'static str)>::new();
    let peers = status.peers.values();
    for (peer, is_self) in peers
        .map(|peer| (peer, false))
        .chain(status.self_peer.as_ref().map(|peer| (peer, true)))
    {
        let Some(name) = peer.dns_name.split('.').next() else {
            continue;
        };
        if name.is_empty()
            || name.starts_with('-')
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !name.starts_with(prefix)
        {
            continue;
        }
        let entry = if is_self {
            (0, "this machine")
        } else if peer.online {
            (1, "tailnet, online")
        } else {
            (2, "tailnet, offline")
        };
        hosts
            .entry(name.to_owned())
            .and_modify(|old| {
                if entry.0 < old.0 {
                    *old = entry;
                }
            })
            .or_insert(entry);
    }
    let mut hosts: Vec<_> = hosts.into_iter().collect();
    hosts.sort_by(|(left, a), (right, b)| a.0.cmp(&b.0).then_with(|| left.cmp(right)));
    hosts
        .into_iter()
        .enumerate()
        .map(|(index, (name, (_, help)))| {
            CompletionCandidate::new(name)
                .help(Some(help.into()))
                .display_order(Some(index))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_names_order_dedup_and_prefix() {
        let status = serde_json::json!({"Self":{"DNSName":"local.example."},"Peer":{
            "a":{"DNSName":"zzz.example.","Online":true,"HostName":"stale"},
            "b":{"DNSName":"aaa.example.","Online":false},
            "c":{"DNSName":"zzz.other.","Online":false},
            "d":{"DNSName":"bad;name.example.","Online":true},
            "e":{"HostName":"missing-dns","Online":true}}});
        let status: Status = serde_json::from_value(status).unwrap();
        let names = |prefix| {
            candidates(&status, prefix)
                .into_iter()
                .map(|candidate| candidate.get_value().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(""), ["local", "zzz", "aaa"]);
        assert_eq!(names("z"), ["zzz"]);
        assert!(host_candidates(OsStr::new("--")).is_empty());
    }
}
