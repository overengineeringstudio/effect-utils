# Shared by evaluated task commands and prepared-tool source selection.
{ repositoryRoot ? ../. }:
{
  testPlatforms = repositoryRoot + "/genie/ci-workflow/test-platforms.json";
  testScheduling = repositoryRoot + "/genie/ci-workflow/test-scheduling.json";
  readerComposition = repositoryRoot + "/genie/ci-workflow/reader-composition.json";
  editorViewSupervisor = repositoryRoot + "/scripts/editor-view-supervisor.py";
  withoutGitLocalEnv = repositoryRoot + "/scripts/without-git-local-env.sh";
}
