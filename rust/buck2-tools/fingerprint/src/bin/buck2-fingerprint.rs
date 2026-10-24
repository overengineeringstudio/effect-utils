use buck2_fingerprint::{fingerprint, fingerprint_input_root, LinkOwner};
use std::path::PathBuf;

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let tree = PathBuf::from(args.next().ok_or("usage: buck2-fingerprint TREE [--dereference] [--backing-root PATH] [--link-owner SOURCE=IDENTITY] [--admission-directory PATH (isolated fixtures only)]" )?);
    let mut dereference = false;
    let mut input_roots = false;
    let mut backing = Vec::new();
    let mut owners = Vec::new();
    let mut admission_directory = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--dereference" => dereference = true,
            "--input-roots" => input_roots = true,
            "--admission-directory" => {
                if admission_directory.is_some() {
                    return Err("duplicate --admission-directory".into());
                }
                let directory =
                    PathBuf::from(args.next().ok_or("missing --admission-directory value")?);
                if !directory.is_absolute() {
                    return Err("--admission-directory must be absolute".into());
                }
                admission_directory = Some(directory);
            }
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
    if input_roots {
        if dereference || !backing.is_empty() || !owners.is_empty() || admission_directory.is_some()
        {
            return Err(
                "--input-roots cannot be combined with editor-view or isolated-fixture modes"
                    .into(),
            );
        }
        println!(
            "digest {}",
            fingerprint_input_root(&tree).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let result = fingerprint(
        &tree,
        dereference,
        &backing,
        &owners,
        admission_directory.as_deref(),
    )
    .map_err(|e| e.to_string())?;
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
