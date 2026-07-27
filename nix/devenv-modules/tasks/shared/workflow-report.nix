# Backward-compatible parameterized wrapper around the canonical report module.
#
# New modules should import `workflow-report-module.nix` directly and configure
# `effectUtils.workflowReport.ciToolsBin` only when overriding the default.
{
  ciToolsBin ? null,
}:
{ pkgs, ... }:
{
  imports = [ ./workflow-report-module.nix ];

  effectUtils.workflowReport.ciToolsBin = ciToolsBin;
  effectUtils.workflowReport.ghBin = "${pkgs.gh}/bin/gh";
}
