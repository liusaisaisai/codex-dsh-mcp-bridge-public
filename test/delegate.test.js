import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { DshDelegate } from '../src/delegate.js'

const temporaryRoots = []

after(async () => {
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

async function workspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-delegate-'))
  temporaryRoots.push(root)
  const workspace = path.join(root, 'project')
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(path.join(root, 'AGENTS.md'), 'outer rules\n', 'utf8')
  await writeFile(path.join(workspace, 'AGENTS.md'), 'project rules\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'index.js'), 'export {}\n', 'utf8')
  return { root, workspace }
}

function request(workspace, overrides = {}) {
  return {
    task: 'Analyze the target files and identify concrete reliability risks.',
    workspace,
    mode: 'analysis',
    allowed_paths: ['src/index.js'],
    acceptance_criteria: ['Name each issue and cite the relevant file.'],
    checks: ['node --check src/index.js'],
    ...overrides,
  }
}

function agentReport(overrides = {}) {
  return JSON.stringify({
    summary: 'One reliability issue found.',
    findings: 'The parser accepts a truncated final record.',
    files_changed: [],
    checks: [{ command: 'node --check src/index.js', exit_code: 0, result: 'syntax valid' }],
    unresolved_questions: [],
    ...overrides,
  })
}

function makeDelegate(workspace, runTask, maxConcurrentTasks = 2) {
  return new DshDelegate({
    config: {
      allowedWorkspaceRoots: [path.dirname(workspace)],
      maxConcurrentTasks,
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 120,
    },
    acpClient: { runTask },
  })
}

test('sends only the bounded task, acceptance criteria, checks, and applicable project rules', async () => {
  const fixture = await workspaceFixture()
  let delegated
  const delegate = makeDelegate(fixture.workspace, async input => {
    delegated = input
    return {
      sessionId: 'test-session',
      processId: 12,
      output: agentReport(),
      stopReason: 'end_turn',
      permissionDenied: false,
    }
  })

  const result = await delegate.delegate(request(fixture.workspace))

  assert.equal(result.status, 'completed')
  assert.equal(result.summary, 'One reliability issue found.')
  assert.deepEqual(result.files_changed, [])
  assert.deepEqual(result.checks, [{
    command: 'node --check src/index.js',
    exit_code: 0,
    result: 'syntax valid',
    status: 'passed',
  }])
  assert.match(delegated.prompt, /outer rules/)
  assert.match(delegated.prompt, /project rules/)
  assert.match(delegated.prompt, /Analyze the target files/)
  assert.match(delegated.prompt, /This task is read-only/)
  assert.match(delegated.prompt, /rejects ACP permission requests/)
  assert.match(delegated.prompt, /acceptance criteria/i)
  assert.doesNotMatch(delegated.prompt, /Codex conversation transcript/)
  assert.equal(delegated.cwd, fixture.workspace)
})

test('extracts a structured report after leading commentary', async () => {
  const fixture = await workspaceFixture()
  const output = `I will inspect the requested file first.\n${agentReport()}`
  const delegate = makeDelegate(fixture.workspace, async () => ({
    output,
    stopReason: 'end_turn',
    permissionDenied: false,
  }))

  const result = await delegate.delegate(request(fixture.workspace))

  assert.equal(result.status, 'completed')
  assert.equal(result.summary, 'One reliability issue found.')
  assert.equal(result.details, 'The parser accepts a truncated final record.')
  assert.deepEqual(result.checks, [{
    command: 'node --check src/index.js',
    exit_code: 0,
    result: 'syntax valid',
    status: 'passed',
  }])
  assert.deepEqual(result.unresolved_questions, [])
})

test('refuses edit mode without starting an ACP session', async () => {
  const fixture = await workspaceFixture()
  let started = false
  const delegate = makeDelegate(fixture.workspace, async () => {
    started = true
    throw new Error('must not be called')
  })

  const result = await delegate.delegate(request(fixture.workspace, { mode: 'edit' }))

  assert.equal(result.status, 'blocked')
  assert.equal(result.error_kind, 'edit_mode_disabled')
  assert.equal(started, false)
})

test('returns a structured failure when the workspace is outside configured roots', async () => {
  const fixture = await workspaceFixture()
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-outside-'))
  temporaryRoots.push(outsideRoot)
  const outside = path.join(outsideRoot, 'workspace')
  await mkdir(outside)
  const delegate = makeDelegate(fixture.workspace, async () => {
    throw new Error('must not be called')
  })

  const result = await delegate.delegate(request(outside))

  assert.equal(result.status, 'failed')
  assert.equal(result.error_kind, 'invalid_workspace')
})

test('enforces the configured concurrency cap and releases capacity after completion', async () => {
  const fixture = await workspaceFixture()
  let releaseFirst
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const pending = new Promise(resolve => { releaseFirst = resolve })
  const delegate = makeDelegate(fixture.workspace, async () => {
    signalStarted()
    await pending
    return { output: agentReport(), stopReason: 'end_turn', permissionDenied: false }
  }, 1)

  const first = delegate.delegate(request(fixture.workspace))
  await started
  const rejected = await delegate.delegate(request(fixture.workspace, { task: 'A second independent analysis task.' }))
  releaseFirst()
  const completed = await first
  const third = await delegate.delegate(request(fixture.workspace, { task: 'A third independent analysis task.' }))

  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.error_kind, 'capacity')
  assert.equal(completed.status, 'completed')
  assert.equal(third.status, 'completed')
})

test('reports caller cancellation as a structured terminal status', async () => {
  const fixture = await workspaceFixture()
  const controller = new AbortController()
  controller.abort(new Error('cancelled by caller'))
  const delegate = makeDelegate(fixture.workspace, async () => {
    throw new Error('must not be called')
  })

  const result = await delegate.delegate(request(fixture.workspace), { signal: controller.signal })

  assert.equal(result.status, 'cancelled')
  assert.equal(result.error_kind, 'cancelled')
})

test('marks agent-reported file changes as blocked in analysis mode', async () => {
  const fixture = await workspaceFixture()
  const delegate = makeDelegate(fixture.workspace, async () => ({
    output: agentReport({ files_changed: ['src/index.js'] }),
    stopReason: 'end_turn',
    permissionDenied: false,
  }))

  const result = await delegate.delegate(request(fixture.workspace))

  assert.equal(result.status, 'blocked')
  assert.equal(result.error_kind, 'reported_changes_in_analysis')
  assert.deepEqual(result.files_changed, [])
  assert.deepEqual(result.agent_reported_files, ['src/index.js'])
})
