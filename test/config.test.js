import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { loadConfig } from '../src/config.js'

const rootsToRemove = []

after(async () => {
  await Promise.all(rootsToRemove.map(root => rm(root, { recursive: true, force: true })))
})

async function configFixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-config-'))
  rootsToRemove.push(root)
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  const launcher = path.join(root, 'dsh.cmd')
  await writeFile(launcher, '@echo off\r\n')
  const configPath = path.join(root, 'config.json')
  const values = {
    dshCommandPath: launcher,
    allowedWorkspaceRoots: [workspace],
    maxConcurrentTasks: 2,
    defaultTimeoutSeconds: 60,
    maxTimeoutSeconds: 300,
    ...overrides,
  }
  await writeFile(configPath, JSON.stringify(values), 'utf8')
  return { root, workspace, launcher, configPath }
}

test('loads validated paths and applies bounded defaults', async () => {
  const fixture = await configFixture({ maxConcurrentTasks: undefined })
  const raw = JSON.parse(await readFile(fixture.configPath, 'utf8'))
  delete raw.maxConcurrentTasks
  delete raw.defaultTimeoutSeconds
  delete raw.maxTimeoutSeconds
  await writeFile(fixture.configPath, JSON.stringify(raw), 'utf8')

  const config = await loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: fixture.configPath } })

  assert.equal(config.dshCommandPath, await realpath(fixture.launcher))
  assert.deepEqual(config.allowedWorkspaceRoots, [await realpath(fixture.workspace)])
  assert.equal(config.maxConcurrentTasks, 3)
  assert.equal(config.defaultTimeoutSeconds, 900)
  assert.equal(config.maxTimeoutSeconds, 3600)
})

test('rejects an empty allowed workspace root list', async () => {
  const fixture = await configFixture({ allowedWorkspaceRoots: [] })

  await assert.rejects(
    loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: fixture.configPath } }),
    /allowedWorkspaceRoots/,
  )
})

test('rejects missing launcher and nonexistent workspace roots', async () => {
  const missingLauncher = await configFixture({ dshCommandPath: path.join(os.tmpdir(), 'missing-dsh.cmd') })
  await assert.rejects(
    loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: missingLauncher.configPath } }),
    /launcher/i,
  )

  const missingRoot = await configFixture({ allowedWorkspaceRoots: [path.join(os.tmpdir(), 'missing-workspace')] })
  await assert.rejects(
    loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: missingRoot.configPath } }),
    /workspace root/i,
  )
})

test('rejects invalid concurrency and timeout relationships', async () => {
  const noConcurrency = await configFixture({ maxConcurrentTasks: 0 })
  await assert.rejects(
    loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: noConcurrency.configPath } }),
    /maxConcurrentTasks/,
  )

  const badTimeout = await configFixture({ defaultTimeoutSeconds: 301, maxTimeoutSeconds: 300 })
  await assert.rejects(
    loadConfig({ env: { CODEX_DSH_BRIDGE_CONFIG: badTimeout.configPath } }),
    /defaultTimeoutSeconds/,
  )
})

test('reads the user-level config path when no explicit path is provided', async () => {
  const fixture = await configFixture()
  const expectedPath = path.join(fixture.root, 'CodexDshBridge', 'config.json')
  await mkdir(path.dirname(expectedPath))
  await writeFile(expectedPath, await readFile(fixture.configPath, 'utf8'), 'utf8')
  const config = await loadConfig({
    env: {
      LOCALAPPDATA: fixture.root,
    },
  })

  assert.equal(config.configPath, expectedPath)
})
