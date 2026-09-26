//! Time and capacity bounded raw archive; index identities survive expiry.
use std::{fs, path::Path};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use crate::now_ms;

pub fn enforce(state: &Path, days: u64, max_bytes: u64) -> Result<()> {
    let root = state.join("archive");
    let conn = Connection::open(state.join("index.sqlite"))?;
    let mut stmt = conn.prepare("select digest, archive_path, bytes, ingested_at from records where archive_path is not null order by ingested_at asc")?;
    let rows: Vec<(String, String, u64, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut total: u64 = rows.iter().map(|row| row.2).sum();
    let cutoff = now_ms() - (days as i64).saturating_mul(86_400_000);
    let root = fs::canonicalize(root)?;
    for (digest, path, size, at) in rows {
        if at >= cutoff && total <= max_bytes { continue; }
        let path = fs::canonicalize(&path).with_context(|| format!("archive {digest} missing; retaining index for repair"))?;
        if !path.starts_with(&root) || path == root { anyhow::bail!("archive path escaped state root"); }
        fs::remove_dir_all(&path)?;
        conn.execute("update records set status='expired', archive_path=null where digest=?1", params![digest])?;
        total = total.saturating_sub(size);
    }
    println!("evidence archive retained {total} bytes, quota {max_bytes} bytes");
    Ok(())
}
