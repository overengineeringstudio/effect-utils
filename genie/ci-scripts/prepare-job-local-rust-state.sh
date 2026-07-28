#!/usr/bin/env bash
# Generated file - DO NOT EDIT
# Source: prepare-job-local-rust-state.sh.genie.ts


# Source this helper at the task boundary. Ambient job-level Cargo state can be
# materialized during environment bootstrap by a different process identity.
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GITHUB_JOB:?GITHUB_JOB is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"

export CARGO_TARGET_DIR="$RUNNER_TEMP/cargo-target-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"
mkdir -p "$CARGO_TARGET_DIR"

# sccache's default TCP server is host-wide. A short per-runner UDS prevents a
# server owned by one self-hosted runner identity from creating another job's
# Cargo artifacts while retaining reuse through the shared cache directory.
sccache_server_key="$(printf '%s' "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB-$RUNNER_NAME" | git hash-object --stdin | cut -c1-16)"
export SCCACHE_SERVER_UDS="$RUNNER_TEMP/sc-$sccache_server_key.sock"
unset sccache_server_key
