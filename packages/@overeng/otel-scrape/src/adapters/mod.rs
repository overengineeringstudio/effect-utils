//! Tool adapters: one self-contained module per wrapped tool, dispatched by a
//! registry instead of `match config.adapter` arms scattered through `lib.rs`.
//!
//! Each adapter implements [`ToolAdapter`], which captures exactly the per-tool
//! variation points otel-scrape's command wrapper needs: how the child's stdout
//! is presented ([`ToolAdapter::stdout_mode`] / [`ToolAdapter::ownership`]),
//! where its structured telemetry comes from ([`ToolAdapter::structured_source`]
//! / [`ToolAdapter::parse`]), and any side-channel or artifact plumbing it needs
//! ([`ToolAdapter::prepare`], [`ToolAdapter::discover_artifacts`], and the two
//! cleanup hooks). `none` — and any unrecognized name — is modeled as the
//! absence of an adapter: [`adapter_for`] returns `None` and `lib.rs` applies the
//! pass-through defaults. parse_args validates the name set against
//! [`adapter_names`], so an unknown name never reaches dispatch; that validation
//! is what makes the previous `unreachable!("unclassified adapter…")` guarantee
//! registry-driven.
//!
//! Adding an adapter is therefore a local change: create `src/adapters/<tool>.rs`
//! implementing [`ToolAdapter`], add one entry to [`ADAPTERS`], and register its
//! telemetry in the registry JSON. The `lib.rs` dispatch functions never change,
//! and each adapter lives in its own file so several can be built in parallel.
//!
//! NOTE on flag injection: the trait deliberately has no static `child_flags`
//! hook. The two adapters that inject anything into the child do so dynamically
//! via [`ToolAdapter::prepare`] (vitest's reporter + output-file flags, node's
//! `NODE_OPTIONS`), while oxlint's `--format=json` is supplied by the usage site,
//! not by otel-scrape — injecting it here would change observable behavior.

use std::io;
use std::path::PathBuf;

use crate::{
    AdapterOutput, AdapterStdoutOwnership, ChildRun, DiscoveredProfileArtifacts, RunConfig,
    StdoutMode,
};

mod deadnix;
pub(crate) mod node_cpuprofile;
mod oxlint;
mod vitest;

use deadnix::DeadnixAdapter;
use node_cpuprofile::NodeCpuProfileAdapter;
use oxlint::OxlintAdapter;
use vitest::VitestAdapter;

/// The registered adapters. Adding an adapter is one entry here plus its module.
/// `none`/unknown names are intentionally absent — they resolve to `None` in
/// [`adapter_for`] and take `lib.rs`'s pass-through defaults.
const ADAPTERS: &[&dyn ToolAdapter] = &[
    &OxlintAdapter,
    &DeadnixAdapter,
    &VitestAdapter,
    &NodeCpuProfileAdapter,
];

/// The per-tool variation the command wrapper dispatches on. Every method has a
/// pass-through default except the two an adapter must define (`name`, `parse`);
/// an adapter overrides only the hooks it actually uses.
pub(crate) trait ToolAdapter: Sync {
    /// The `--adapter` value that selects this adapter and the `adapter.name`
    /// carried in telemetry.
    fn name(&self) -> &'static str;

    /// How the wrapped child's stdout is presented (decision 0017). `nested` is
    /// true when the child is itself an otel-scrape invocation.
    fn stdout_mode(&self, nested: bool) -> StdoutMode;

    /// Which layer owns the child's stdout presentation. The default matches
    /// every non-side-channel adapter: this wrapper owns a leaf, the inner
    /// wrapper owns a nested invocation.
    fn ownership(&self, nested: bool) -> AdapterStdoutOwnership {
        if nested {
            AdapterStdoutOwnership::ChildWrapper
        } else {
            AdapterStdoutOwnership::ThisWrapper
        }
    }

    /// The declared structured-source bytes, read once after the child exits —
    /// captured stdout, a side-channel file, or (default) nothing.
    fn structured_source(&self, child: &ChildRun) -> Vec<u8> {
        let _ = child;
        Vec::new()
    }

    /// Parse the structured source into sink-facing records plus an optional
    /// terminal render. `ownership` is the resolved presentation ownership; an
    /// adapter parses only under the ownership it owns, reproducing the previous
    /// `match (ownership, adapter)` dispatch.
    fn parse(
        &self,
        source: &[u8],
        ownership: AdapterStdoutOwnership,
    ) -> (Vec<AdapterOutput>, Option<String>);

    /// Plan any child-command mutation this adapter needs before spawn: extra
    /// argv, extra env, and the side-channel/artifact state stored on the
    /// [`ChildRun`]. Default: nothing to plan.
    fn prepare(&self, config: &RunConfig) -> io::Result<AdapterPrep> {
        let _ = config;
        Ok(AdapterPrep::default())
    }

    /// Discover the profile artifacts the child produced (node-cpuprofile's
    /// `.cpuprofile`). Default: none.
    fn discover_artifacts(&self, child: &ChildRun) -> DiscoveredProfileArtifacts {
        let _ = child;
        DiscoveredProfileArtifacts::default()
    }

    /// Remove adapter-owned profile artifacts once discovered and stored
    /// (node-cpuprofile's temp dir). Default: nothing to clean.
    fn cleanup_artifacts(&self, child: &ChildRun) {
        let _ = child;
    }

    /// Remove an adapter-owned structured-source side-channel once read and
    /// presented (the vitest JSON file). Default: nothing to clean.
    fn cleanup_structured_source(&self, child: &ChildRun) {
        let _ = child;
    }
}

/// Child-command mutation + post-exit state an adapter plans in
/// [`ToolAdapter::prepare`]. Only the active adapter's fields are ever populated;
/// the rest keep their [`Default`] (empty) values.
#[derive(Default)]
pub(crate) struct AdapterPrep {
    /// Extra argv appended to the child command (vitest reporter/output-file).
    pub(crate) inject_args: Vec<String>,
    /// Extra environment variables set on the child (node `NODE_OPTIONS`).
    pub(crate) env: Vec<(String, String)>,
    /// node-cpuprofile temp dir, carried on the [`ChildRun`] for artifact
    /// discovery + cleanup.
    pub(crate) node_profile_dir: Option<PathBuf>,
    /// vitest side-channel file to read after the child exits.
    pub(crate) sidechannel_file: Option<PathBuf>,
    /// Whether otel-scrape created (and must delete) `sidechannel_file`.
    pub(crate) sidechannel_owned: bool,
}

/// The adapter selected by `name`, or `None` for `none` and any unrecognized
/// value (both take `lib.rs`'s pass-through defaults).
pub(crate) fn adapter_for(name: &str) -> Option<&'static dyn ToolAdapter> {
    ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.name() == name)
}

/// The registered adapter names, for parse_args validation and usage strings.
pub(crate) fn adapter_names() -> impl Iterator<Item = &'static str> {
    ADAPTERS.iter().map(|adapter| adapter.name())
}

/// Plan the active adapter's child-command mutation before spawn, or nothing for
/// `none`/unknown.
pub(crate) fn prepare(config: &RunConfig) -> io::Result<AdapterPrep> {
    match adapter_for(&config.adapter) {
        Some(adapter) => adapter.prepare(config),
        None => Ok(AdapterPrep::default()),
    }
}
