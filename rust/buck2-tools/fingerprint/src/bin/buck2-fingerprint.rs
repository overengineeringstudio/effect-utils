use buck2_fingerprint::{fingerprint, fingerprint_batch, fingerprint_input_root, LinkOwner};
use std::path::PathBuf;

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let first = args.next().ok_or("usage: buck2-fingerprint TREE [--dereference] [--backing-root PATH] [--link-owner SOURCE=IDENTITY] | --batch --tree ROOT [--tree ROOT ...] [--link-owner SOURCE=IDENTITY ...]")?;
    let batch = first == "--batch";
    let mut trees = if batch {
        Vec::new()
    } else {
        vec![PathBuf::from(first)]
    };
    let mut dereference = false;
    let mut input_roots = false;
    let mut backing = Vec::new();
    let mut owners = Vec::new();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--tree" if batch => {
                trees.push(PathBuf::from(args.next().ok_or("missing --tree value")?));
            }
            "--dereference" => dereference = true,
            "--input-roots" => input_roots = true,
            "--backing-root" => backing.push(PathBuf::from(
                args.next().ok_or("missing --backing-root value")?,
            )),
            "--link-owner" => {
                let value = args.next().ok_or("missing --link-owner value")?;
                let (source, identity) = value
                    .rsplit_once('=')
                    .ok_or("expected --link-owner SOURCE=IDENTITY")?;
                owners.push(LinkOwner {
                    source: PathBuf::from(source),
                    identity: identity.to_owned(),
                });
            }
            _ => return Err(format!("unexpected fingerprint argument: {flag}")),
        }
    }
    if batch {
        if trees.is_empty() {
            return Err("--batch requires at least one --tree ROOT".into());
        }
        if input_roots || dereference || !backing.is_empty() {
            return Err("--batch supports only --tree and --link-owner".into());
        }
        // Do not emit any successful records until every root has passed its proof.
        let results = fingerprint_batch(&trees, false, &[], &owners).map_err(|e| e.to_string())?;
        for (index, result) in results.into_iter().enumerate() {
            println!(
                "{index} {} {} {}",
                result.digest,
                result.resolved_links_digest.as_deref().unwrap_or("-"),
                result.literal_links_digest.as_deref().unwrap_or("-"),
            );
        }
        return Ok(());
    }
    let tree = &trees[0];
    if input_roots {
        if dereference || !backing.is_empty() || !owners.is_empty() {
            return Err("--input-roots cannot be combined with editor-view modes".into());
        }
        println!(
            "digest {}",
            fingerprint_input_root(tree).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let result = fingerprint(tree, dereference, &backing, &owners).map_err(|e| e.to_string())?;
    println!("digest {}", result.digest);
    if let Some(value) = result.resolved_links_digest {
        println!("resolved {value}");
    }
    if let Some(value) = result.literal_links_digest {
        println!("literal {value}");
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
