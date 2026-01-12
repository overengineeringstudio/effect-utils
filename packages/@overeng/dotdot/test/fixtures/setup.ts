/**
 * Test fixtures setup for dotdot
 *
 * Creates temporary directories with git repos and config files for testing
 */

import { execSync } from 'node:child_process'
// TODO rewrite to use effect fs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type RepoFixture = {
  name: string
  /** Create as git repo */
  isGitRepo?: boolean
  /** Create with dirty working tree */
  isDirty?: boolean
  /** Has its own dotdot.json */
  hasConfig?: boolean
  /** Config content if hasConfig */
  configRepos?: Record<string, { url: string; rev?: string }>
}

export type WorkspaceFixture = {
  /** Root config repos */
  rootRepos?: Record<string, { url: string; rev?: string }>
  /** Peer repos to create */
  repos: RepoFixture[]
}

/** Create a temporary workspace for testing */
export const createWorkspace = (fixture: WorkspaceFixture): string => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdot-test-'))

  // Create root config at workspace root (ONLY root config here, no dotdot.json)
  // This follows the design: workspace root has dotdot-root.json, member repos have dotdot.json
  if (fixture.rootRepos && Object.keys(fixture.rootRepos).length > 0) {
    const configContent = generateConfig(fixture.rootRepos)
    fs.writeFileSync(path.join(tmpDir, 'dotdot-root.json'), configContent)
  } else {
    const emptyConfig = JSON.stringify({ repos: {} }, null, 2) + '\n'
    fs.writeFileSync(path.join(tmpDir, 'dotdot-root.json'), emptyConfig)
  }

  // Create repos
  for (const repo of fixture.repos) {
    const repoPath = path.join(tmpDir, repo.name)
    fs.mkdirSync(repoPath, { recursive: true })

    if (repo.isGitRepo !== false) {
      // Initialize git repo
      execSync('git init', { cwd: repoPath, stdio: 'ignore' })
      execSync('git config user.email "test@test.com"', {
        cwd: repoPath,
        stdio: 'ignore',
      })
      execSync('git config user.name "Test"', {
        cwd: repoPath,
        stdio: 'ignore',
      })

      // Create initial commit
      fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repo.name}\n`)
      execSync('git add .', { cwd: repoPath, stdio: 'ignore' })
      execSync('git commit -m "Initial commit"', {
        cwd: repoPath,
        stdio: 'ignore',
      })

      if (repo.isDirty) {
        // Make working tree dirty
        fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'dirty\n')
      }
    }

    if (repo.hasConfig && repo.configRepos) {
      const configContent = generateConfig(repo.configRepos)
      fs.writeFileSync(path.join(repoPath, 'dotdot.json'), configContent)
    }
  }

  return tmpDir
}

/** Clean up a workspace */
export const cleanupWorkspace = (workspacePath: string): void => {
  fs.rmSync(workspacePath, { recursive: true, force: true })
}

/** Generate JSON config file content */
const generateConfig = (repos: Record<string, { url: string; rev?: string }>): string => {
  const reposObj: Record<string, { url: string; rev?: string }> = {}
  for (const [name, config] of Object.entries(repos)) {
    reposObj[name] = { url: config.url }
    if (config.rev) {
      reposObj[name].rev = config.rev
    }
  }
  return JSON.stringify({ repos: reposObj }, null, 2) + '\n'
}

/** Get the current git rev of a repo */
export const getGitRev = (repoPath: string): string => {
  return execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
  }).trim()
}

/** Create a bare git repository (for clone tests) */
export const createBareRepo = (name: string): string => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdot-bare-'))
  const repoPath = path.join(tmpDir, `${name}.git`)

  // Create bare repo directory and init
  fs.mkdirSync(repoPath)
  execSync('git init --bare', { cwd: repoPath, stdio: 'ignore' })

  // Create a regular repo, add a commit, then push to bare
  const tempRepoPath = path.join(tmpDir, 'temp-repo')
  fs.mkdirSync(tempRepoPath)
  execSync('git init', { cwd: tempRepoPath, stdio: 'ignore' })
  execSync('git config user.email "test@test.com"', {
    cwd: tempRepoPath,
    stdio: 'ignore',
  })
  execSync('git config user.name "Test"', {
    cwd: tempRepoPath,
    stdio: 'ignore',
  })
  fs.writeFileSync(path.join(tempRepoPath, 'README.md'), `# ${name}\n`)
  execSync('git add .', { cwd: tempRepoPath, stdio: 'ignore' })
  execSync('git commit -m "Initial commit"', {
    cwd: tempRepoPath,
    stdio: 'ignore',
  })
  execSync(`git push ${repoPath} HEAD:main`, {
    cwd: tempRepoPath,
    stdio: 'ignore',
  })

  // Clean up temp repo
  fs.rmSync(tempRepoPath, { recursive: true, force: true })

  return repoPath
}

/** Add a commit to a repo */
export const addCommit = (repoPath: string, message: string, filename?: string): string => {
  const file = filename ?? `file-${Date.now()}.txt`
  fs.writeFileSync(path.join(repoPath, file), `${message}\n`)
  execSync('git add .', { cwd: repoPath, stdio: 'ignore' })
  execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: 'ignore' })
  return getGitRev(repoPath)
}

/** Read the root config file content */
export const readConfig = (workspacePath: string): string => {
  return fs.readFileSync(path.join(workspacePath, 'dotdot-root.json'), 'utf-8')
}

/** Create package target directory with files */
export const createPackageTarget = (repoPath: string, packagePath: string): void => {
  const targetPath = path.join(repoPath, packagePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.mkdirSync(targetPath, { recursive: true })
  fs.writeFileSync(path.join(targetPath, 'package.json'), '{"name": "test-package"}\n')
}

type PackageConfig = { path: string; install?: string }

/** Generate JSON config with packages field */
export const generateConfigWithPackages = (
  repos: Record<string, { url: string; rev?: string; packages?: Record<string, PackageConfig> }>,
): string => {
  const reposObj: Record<
    string,
    { url: string; rev?: string; packages?: Record<string, PackageConfig> }
  > = {}
  for (const [name, config] of Object.entries(repos)) {
    reposObj[name] = { url: config.url }
    if (config.rev) {
      reposObj[name].rev = config.rev
    }
    if (config.packages && Object.keys(config.packages).length > 0) {
      reposObj[name].packages = config.packages
    }
  }
  return JSON.stringify({ repos: reposObj }, null, 2) + '\n'
}
