import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  readApplicableInstructions,
  resolveAllowedPaths,
  validateWorkspace,
} from '../src/workspace.js'

const rootsToRemove = []

after(async () => {
  await Promise.all(rootsToRemove.map(root => rm(root, { recursive: true, force: true })))
})

async function workspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-workspace-'))
  rootsToRemove.push(root)
  const allowedRoot = path.join(root, 'allowed')
  const workspace = path.join(allowedRoot, 'project')
  await mkdir(workspace, { recursive: true })
  return { root, allowedRoot, workspace }
}

test('canonicalizes a workspace and chooses its most specific allowed root', async () => {
  const fixture = await workspaceFixture()
  const nestedRoot = path.join(fixture.workspace, 'nested')
  await mkdir(nestedRoot)

  const result = await validateWorkspace(fixture.workspace, [fixture.allowedRoot, nestedRoot])

  assert.equal(result.workspacePath, fixture.workspace)
  assert.equal(result.allowedRoot, fixture.allowedRoot)
})

test('rejects a sibling path outside an allowed root', async () => {
  const fixture = await workspaceFixture()
  const sibling = `${fixture.allowedRoot}-other`
  await mkdir(sibling)

  await assert.rejects(
    validateWorkspace(sibling, [fixture.allowedRoot]),
    /outside configured workspace roots/,
  )
})

test('rejects a workspace reached through a junction that resolves outside the root', async () => {
  const fixture = await workspaceFixture()
  const outside = path.join(fixture.root, 'outside')
  const junction = path.join(fixture.allowedRoot, 'escape')
  await mkdir(outside)
  await symlink(outside, junction, 'junction')

  await assert.rejects(
    validateWorkspace(junction, [fixture.allowedRoot]),
    /outside configured workspace roots/,
  )
})

test('accepts only existing project-relative paths without traversal', async () => {
  const fixture = await workspaceFixture()
  const sourceFile = path.join(fixture.workspace, 'src', 'main.js')
  await mkdir(path.dirname(sourceFile))
  await writeFile(sourceFile, 'export {}\n', 'utf8')

  const result = await resolveAllowedPaths(fixture.workspace, ['src/main.js'])

  assert.deepEqual(result.map(item => item.relativePath), ['src/main.js'])
  await assert.rejects(resolveAllowedPaths(fixture.workspace, ['../outside.txt']), /outside the workspace/)
  await assert.rejects(resolveAllowedPaths(fixture.workspace, ['missing.txt']), /does not exist/)
})

test('rejects an allowed path whose junction escapes the workspace', async () => {
  const fixture = await workspaceFixture()
  const outside = path.join(fixture.root, 'outside')
  const junction = path.join(fixture.workspace, 'external')
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'not in workspace', 'utf8')
  await symlink(outside, junction, 'junction')

  await assert.rejects(
    resolveAllowedPaths(fixture.workspace, ['external/secret.txt']),
    /outside workspace/,
  )
})

test('loads applicable AGENTS files from the allowed root to each target directory', async () => {
  const fixture = await workspaceFixture()
  const sourceDirectory = path.join(fixture.workspace, 'src')
  const sourceFile = path.join(sourceDirectory, 'main.js')
  await mkdir(sourceDirectory)
  await writeFile(path.join(fixture.root, 'AGENTS.md'), 'outside root\n', 'utf8')
  await writeFile(path.join(fixture.allowedRoot, 'AGENTS.md'), 'root rules\n', 'utf8')
  await writeFile(path.join(fixture.workspace, 'AGENTS.md'), 'project rules\n', 'utf8')
  await writeFile(path.join(sourceDirectory, 'AGENTS.md'), 'source rules\n', 'utf8')
  await writeFile(sourceFile, 'export {}\n', 'utf8')
  const allowedPaths = await resolveAllowedPaths(fixture.workspace, ['src/main.js'])

  const instructions = await readApplicableInstructions({
    workspacePath: fixture.workspace,
    allowedRoot: fixture.allowedRoot,
    allowedPaths,
  })

  assert.deepEqual(instructions.map(item => item.content.trim()), [
    'root rules',
    'project rules',
    'source rules',
  ])
})

test('fails closed when an applicable AGENTS path cannot be read as a file', async () => {
  const fixture = await workspaceFixture()
  await mkdir(path.join(fixture.workspace, 'AGENTS.md'))

  await assert.rejects(
    readApplicableInstructions({
      workspacePath: fixture.workspace,
      allowedRoot: fixture.allowedRoot,
      allowedPaths: [],
    }),
    /AGENTS\.md/,
  )
})
