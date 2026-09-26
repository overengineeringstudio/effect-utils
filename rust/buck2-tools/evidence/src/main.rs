//! Content-addressed evidence capture, durable queue, and read-only resolver.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use buck2_evidence::http::{self, AppState};
use buck2_evidence::pipeline;
use buck2_evidence::{index, now_ms, seal, store, Config, StepError};
use rusqlite::{params, Connection, OptionalExtension};
use tokio::sync::Notify;

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    Seal {
        #[arg(long)] spool: PathBuf,
        #[arg(long)] run_id: String,
        #[arg(long)] task_key: String,
    },
    SealClose {
        #[arg(long)] spool: PathBuf,
        #[arg(long)] run_id: String,
        #[arg(long)] repository: String,
        #[arg(long)] jobs_json: PathBuf,
    },
    Upload {
        #[arg(long)] spool: PathBuf,
        #[arg(long, env = "BUCK2_EVIDENCE_UPLOAD_URL")] url: Option<String>,
    },
    Ingest {
        #[command(flatten)] common: Common,
        #[arg(long)] spool: PathBuf,
        #[arg(long)] local: bool,
    },
    Serve {
        #[command(flatten)] common: Common,
        #[arg(long)] upload_socket: PathBuf,
        #[arg(long)] resolver_socket: PathBuf,
        #[arg(long)] metrics_address: Option<String>,
        #[arg(long)] allow_local_upload: bool,
        #[arg(long, default_value_t = 20)] sweep_secs: u64,
    },
    Drain { #[command(flatten)] common: Common },
    Backfill { #[command(flatten)] common: Common },
    Retention {
        #[arg(long)] state_dir: PathBuf,
        #[arg(long, default_value_t = 365)] days: u64,
        #[arg(long, default_value_t = 161061273600)] max_bytes: u64,
    },
}

#[derive(Args, Clone)]
struct Common {
    #[arg(long)]
    state_dir: Option<PathBuf>,
    #[arg(long, env = "OTEL_EXPORTER_OTLP_ENDPOINT", default_value = "http://127.0.0.1:4318")]
    otlp_endpoint: String,
    #[arg(long, env = "BUCK2_EVIDENCE_TEMPO_URL", default_value = "http://127.0.0.1:42032")]
    tempo_url: String,
    #[arg(long, env = "BUCK2_EVIDENCE_GRAFANA_URL", default_value = "http://127.0.0.1:3700")]
    grafana_url: String,
    #[arg(long, default_value_t = 30)]
    readback_timeout_secs: u64,
    #[arg(long, default_value_t = 2)]
    workers: usize,
    #[arg(long, default_value_t = 12)]
    max_attempts: i64,
    /// Backoff cap for transient failures (Tempo/Alloy down).
    #[arg(long, default_value_t = 30)]
    backoff_cap_secs: i64,
    /// On retries, probe Tempo by id before re-pushing an unrecorded chunk (dedup guard).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    probe_repush: bool,
}

impl Common {
    fn config(&self) -> Config {
        Config {
            state: self.state_dir.clone().unwrap_or_else(|| std::env::temp_dir().join("buck2-evidence-local")),
            otlp: self.otlp_endpoint.clone(),
            tempo: self.tempo_url.clone(),
            readback_timeout: Duration::from_secs(self.readback_timeout_secs),
            grafana: self.grafana_url.clone(),
        }
    }
}

#[derive(Default)]
struct Metrics {
    ingested: AtomicU64,
    dead: AtomicU64,
    retries: AtomicU64,
    pushes: AtomicU64,
    push_skipped: AtomicU64,
    prepares: AtomicU64,
    enqueued: AtomicU64,
    swept: AtomicU64,
    ingest_ms_sum: AtomicU64,
}

struct Svc {
    cfg: Arc<Config>,
    common: Common,
    notify: Notify,
    m: Metrics,
    client: reqwest::Client,
}

fn init_queue(conn: &Connection) -> rusqlite::Result<()> {
    index::init(conn)?;
    conn.execute_batch(
        "create table if not exists jobs (
           digest text primary key references records(digest),
           state text not null,             -- queued | leased | done | dead
           attempts integer not null default 0,
           next_at integer not null, leased_at integer, last_error text);
         create index if not exists jobs_due on jobs(state, next_at);
         create table if not exists pushes (digest text not null, chunk integer not null,
           primary key (digest, chunk));",
    )
}

/// records row + jobs row in one transaction: the enqueue is atomic with the index insert.
fn enqueue(conn: &mut Connection, digest: &str, m: &store::Manifest, bytes: u64) -> rusqlite::Result<bool> {
    let tx = conn.transaction()?;
    let now = now_ms();
    index::insert_uploaded(&tx, digest, m, bytes, now)?;
    let n = tx.execute(
        "insert into jobs (digest, state, next_at) values (?1, 'queued', ?2) on conflict(digest) do nothing",
        params![digest, now],
    )?;
    tx.commit()?;
    Ok(n == 1)
}

impl Svc {
    fn db(&self) -> rusqlite::Result<Connection> {
        index::open(&self.cfg.index_path())
    }

    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&Svc, &mut Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> rusqlite::Result<T> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = me.db()?;
            f(&me, &mut conn)
        })
        .await
        .unwrap()
    }

    /// Crash recovery: this process is the queue's only owner, so any lease is orphaned.
    fn recover(conn: &Connection) -> rusqlite::Result<usize> {
        conn.execute("update jobs set state='queued', next_at=?1 where state='leased'", [now_ms()])
    }

    /// Backfill: stored-but-unindexed records and indexed-but-unqueued records.
    fn sweep(&self, conn: &mut Connection) -> rusqlite::Result<usize> {
        let mut found = 0;
        if let Ok(rd) = std::fs::read_dir(self.cfg.store()) {
            for e in rd.flatten() {
                let digest = e.file_name().to_string_lossy().to_string();
                if !store::is_digest(&digest) || index::status_of(conn, &digest)?.is_some() {
                    continue;
                }
                if let Ok(m) = store::read_manifest(&e.path()) {
                    let bytes = m.files.iter().map(|f| f.bytes).sum();
                    if enqueue(conn, &digest, &m, bytes)? {
                        found += 1;
                    }
                }
            }
        }
        found += conn.execute(
            "insert into jobs (digest, state, next_at)
             select digest, 'queued', ?1 from records r
             where r.status in ('uploaded','ingesting') and not exists (select 1 from jobs j where j.digest=r.digest)",
            [now_ms()],
        )?;
        // A worker that hung past every internal timeout.
        found += conn.execute(
            "update jobs set state='queued' where state='leased' and leased_at < ?1",
            [now_ms() - 15 * 60_000],
        )?;
        Ok(found)
    }

    fn claim(conn: &Connection) -> rusqlite::Result<Option<(String, i64)>> {
        let now = now_ms();
        conn.query_row(
            "update jobs set state='leased', attempts=attempts+1, leased_at=?1
             where digest=(select digest from jobs where state='queued' and next_at<=?1 order by next_at limit 1)
             returning digest, attempts",
            [now],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
    }

    fn next_due(conn: &Connection) -> rusqlite::Result<Option<i64>> {
        conn.query_row("select min(next_at) from jobs where state='queued'", [], |r| r.get(0))
    }

    async fn worker(self: Arc<Self>, exit_when_idle: bool) {
        loop {
            match self.blocking(|_, c| Self::claim(c)).await {
                Ok(Some((digest, attempts))) => self.process(&digest, attempts).await,
                Ok(None) => {
                    if exit_when_idle {
                        return;
                    }
                    let wait = match self.blocking(|_, c| Self::next_due(c)).await {
                        Ok(Some(t)) => Duration::from_millis((t - now_ms()).clamp(10, 1000) as u64),
                        _ => Duration::from_secs(1),
                    };
                    let _ = tokio::time::timeout(wait, self.notify.notified()).await;
                }
                Err(e) => {
                    tracing::error!(error = %e, "claim failed");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    async fn process(self: &Arc<Self>, digest: &str, attempts: i64) {
        let started = std::time::Instant::now();
        let result = self.ingest(digest, attempts).await;
        let d = digest.to_string();
        let max = self.common.max_attempts;
        let cap = self.common.backoff_cap_secs * 1000;
        let outcome = match result {
            Ok(()) => {
                self.m.ingested.fetch_add(1, Relaxed);
                self.m.ingest_ms_sum.fetch_add(started.elapsed().as_millis() as u64, Relaxed);
                self.blocking(move |_, c| {
                    c.execute("update jobs set state='done', last_error=null where digest=?1", [&d])?;
                    c.execute("delete from pushes where digest=?1", [&d])
                })
                .await
                .map(|_| ())
            }
            Err(e) => {
                let permanent = pipeline::is_permanent(&e) || attempts >= max;
                let msg = e.to_string();
                tracing::warn!(digest = %d, attempts, permanent, error = %msg, "ingest failed");
                if permanent {
                    self.m.dead.fetch_add(1, Relaxed);
                } else {
                    self.m.retries.fetch_add(1, Relaxed);
                }
                self.blocking(move |_, c| {
                    if permanent {
                        c.execute("update jobs set state='dead', last_error=?2 where digest=?1", params![d, msg])?;
                        index::mark_failed(c, &d, &msg)
                    } else {
                        let backoff = (1000i64 << (attempts - 1).min(16)).min(cap);
                        c.execute(
                            "update jobs set state='queued', next_at=?2, last_error=?3 where digest=?1",
                            params![d, now_ms() + backoff, msg],
                        )?;
                        index::note_error(c, &d, &msg)
                    }
                })
                .await
            }
        };
        if let Err(e) = outcome {
            tracing::error!(error = %e, "queue update failed");
        }
    }

    async fn ingest(self: &Arc<Self>, digest: &str, attempts: i64) -> Result<(), StepError> {
        let d = digest.to_string();
        let status = self
            .blocking(move |_, c| {
                let s = index::status_of(c, &d)?;
                if s.as_deref() != Some("ingested") {
                    index::mark_started(c, &d, now_ms())?;
                }
                Ok(s)
            })
            .await
            .map_err(buck2_evidence::transient)?;
        if status.as_deref() == Some("ingested") {
            return Ok(());
        }
        self.m.prepares.fetch_add(1, Relaxed);
        let summary = pipeline::prepare(&self.cfg, digest).await?;
        let d = digest.to_string();
        let done: std::collections::HashSet<i64> = self
            .blocking(move |_, c| {
                let mut st = c.prepare("select chunk from pushes where digest=?1")?;
                let rows = st.query_map([&d], |r| r.get(0))?;
                rows.collect()
            })
            .await
            .map_err(buck2_evidence::transient)?;
        for i in 0..summary.chunks {
            if done.contains(&(i as i64)) {
                self.m.push_skipped.fetch_add(1, Relaxed);
                continue;
            }
            if attempts > 1 && self.common.probe_repush && pipeline::chunk_visible(&self.client, &self.cfg, digest, i).await? {
                self.m.push_skipped.fetch_add(1, Relaxed);
            } else {
                pipeline::push_chunk(&self.client, &self.cfg, digest, i).await?;
                self.m.pushes.fetch_add(1, Relaxed);
            }
            let d = digest.to_string();
            self.blocking(move |_, c| c.execute("insert or ignore into pushes values (?1, ?2)", params![d, i as i64]))
                .await
                .map_err(buck2_evidence::transient)?;
        }
        let rb = pipeline::readback(&self.client, &self.cfg, digest).await?;
        let cfg = self.cfg.clone();
        let d = digest.to_string();
        tokio::task::spawn_blocking(move || pipeline::finalize(&cfg, &d, &rb)).await.unwrap()?;
        Ok(())
    }

    fn metrics_text(&self) -> String {
        let m = &self.m;
        let rss_kb = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).map(|l| l.split_whitespace().nth(1).unwrap_or("0").to_string()))
            .unwrap_or_default();
        let queue = self
            .db()
            .and_then(|c| {
                let mut st = c.prepare("select state, count(*) from jobs group by state")?;
                let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default();
        let mut out = String::from("# TYPE evidence_queue_jobs gauge\n");
        for (s, n) in queue {
            out += &format!("evidence_queue_jobs{{state=\"{s}\"}} {n}\n");
        }
        for (name, v) in [
            ("evidence_ingest_ok_total", &m.ingested),
            ("evidence_ingest_dead_total", &m.dead),
            ("evidence_ingest_retries_total", &m.retries),
            ("evidence_otlp_chunks_pushed_total", &m.pushes),
            ("evidence_otlp_chunks_skipped_total", &m.push_skipped),
            ("evidence_prepare_total", &m.prepares),
            ("evidence_enqueued_total", &m.enqueued),
            ("evidence_swept_total", &m.swept),
            ("evidence_ingest_ms_sum", &m.ingest_ms_sum),
        ] {
            out += &format!("# TYPE {name} counter\n{name} {}\n", v.load(Relaxed));
        }
        out += &format!("process_resident_memory_kb {rss_kb}\n");
        out
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let cli = Cli::parse();
    let (common, serve, local) = match cli.cmd {
        Cmd::Seal { spool, run_id, task_key } => {
            println!("sha256:{}", seal::seal(&spool, &run_id, &task_key)?);
            return Ok(());
        }
        Cmd::SealClose { spool, run_id, repository, jobs_json } => {
            println!("sha256:{}", buck2_evidence::close::seal_close(&spool, &run_id, &repository, &jobs_json)?);
            return Ok(());
        }
        Cmd::Upload { spool, url } => {
            println!("{}", buck2_evidence::transport::upload(&spool, url.as_deref()).await?);
            return Ok(());
        }
        Cmd::Retention { state_dir, days, max_bytes } => {
            buck2_evidence::retention::enforce(&state_dir, days, max_bytes)?;
            return Ok(());
        }
        Cmd::Serve { common, upload_socket, resolver_socket, metrics_address, allow_local_upload, sweep_secs } =>
            (common, Some((upload_socket, resolver_socket, metrics_address, allow_local_upload, sweep_secs)), None),
        Cmd::Drain { common } => (common, None, None),
        Cmd::Backfill { common } => (common, None, None),
        Cmd::Ingest { common, spool, local: true } => (common, None, Some(spool)),
        Cmd::Ingest { local: false, .. } => anyhow::bail!("ingest requires --local with --spool"),
    };
    let cfg = Arc::new(common.config());
    cfg.ensure_dirs()?;
    let svc = Arc::new(Svc {
        cfg: cfg.clone(),
        common: common.clone(),
        notify: Notify::new(),
        m: Metrics::default(),
        client: pipeline::http_client(),
    });
    let recovered = svc
        .blocking(|s, c| {
            init_queue(c)?;
            buck2_evidence::close::init(c)?;
            let r = Svc::recover(c)?;
            let swept = s.sweep(c)?;
            Ok((r, swept))
        })
        .await?;
    tracing::info!(recovered = recovered.0, swept = recovered.1, "queue ready");

    if let Some(spool) = local {
        let (digest, body) = buck2_evidence::transport::bundle(&spool)?;
        match store::accept(&cfg, &digest, &body) {
            Ok(store::UploadOutcome::Stored(manifest)) => {
                svc.blocking(move |_, c| enqueue(c, &digest, &manifest, body.len() as u64)).await?;
            }
            Ok(store::UploadOutcome::AlreadyStored) => {}
            Err(error) => anyhow::bail!("local record rejected: {error:?}"),
        }
    }
    let Some((upload_socket, resolver_socket, metrics_address, allow_local_upload, sweep_secs)) = serve else {
        let workers: Vec<_> = (0..common.workers).map(|_| tokio::spawn(svc.clone().worker(true))).collect();
        for worker in workers { worker.await?; }
        println!("{}", svc.metrics_text());
        return Ok(());
    };

    for _ in 0..common.workers {
        tokio::spawn(svc.clone().worker(false));
    }
    let sweeper = svc.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(sweep_secs));
        tick.tick().await;
        loop {
            tick.tick().await;
            match sweeper.blocking(|s, c| s.sweep(c)).await {
                Ok(n) if n > 0 => {
                    sweeper.m.swept.fetch_add(n as u64, Relaxed);
                    tracing::info!(n, "sweep enqueued");
                    sweeper.notify.notify_waiters();
                }
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "sweep failed"),
            }
        }
    });
    let closer = svc.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Err(e) = buck2_evidence::close::reconcile(&closer.cfg, &closer.client).await {
                tracing::warn!(error = %e, "close reconciliation failed; retrying");
            }
        }
    });

    let on_stored_svc = svc.clone();
    let metrics_svc = svc.clone();
    let state = AppState {
        cfg,
        allow_local_upload,
        on_stored: Arc::new(move |digest, manifest, bytes| {
            let svc = on_stored_svc.clone();
            Box::pin(async move {
                let fresh = svc
                    .blocking(move |_, c| enqueue(c, &digest, &manifest, bytes))
                    .await
                    .map_err(|e| e.to_string())?;
                if fresh {
                    svc.m.enqueued.fetch_add(1, Relaxed);
                }
                svc.notify.notify_one();
                Ok(())
            })
        }),
        extra_metrics: Arc::new(move || metrics_svc.metrics_text()),
    };
    let resolver = http::resolver_router(state.clone());
    let metrics = http::metrics_router(state.clone());
    let upload = http::upload_router(state);
    tracing::info!(upload = %upload_socket.display(), resolver = %resolver_socket.display(), "listening");
    let upload_task = http::serve_unix(&upload_socket, upload);
    let resolver_task = http::serve_unix(&resolver_socket, resolver);
    if let Some(addr) = metrics_address {
        let parsed: std::net::SocketAddr = addr.parse()?;
        if !parsed.ip().is_loopback() { anyhow::bail!("metrics listener must bind loopback"); }
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tokio::select! {
            result = upload_task => result,
            result = resolver_task => result,
            result = axum::serve(listener, metrics) => result.map_err(Into::into),
        }
    } else {
        tokio::select! { result = upload_task => result, result = resolver_task => result }
    }
}
