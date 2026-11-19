import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { AcpClient, resolveLaunchSpec } from '../src/acp-client.js'

const clients = new Set()
const temporaryRoots = []
const fakeAgentPath = path.join(import.meta.dirname, 'fixtures', 'fake-acp-agent.js')

after(async () => {
  await Promise.all([...clients].map(client => client.dispose()))
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

function makeClient(behavior = 'echo', options = {}) {
  const client = new AcpClient({
    commandPath: process.execPath,
    launcherArgs: [fakeAgentPath, behavior, ...(options.args ?? [])],
    env: options.env ?? process.env,
    startupTimeoutMs: 5000,
    stopTimeoutMs: options.stopTimeoutMs ?? 1500,
  })
  clients.add(client)
  return client
}

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-acp-'))
  temporaryRoots.push(root)
  return root
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('fake ACP agent did not receive the prompt')
}

test('multiplexes concurrent sessions without crossing their assistant output', async () => {
  const client = makeClient()
  const cwd = await temporaryWorkspace()

  const [first, second] = await Promise.all([
    client.runTask({ cwd, prompt: 'alpha' }),
    client.runTask({ cwd, prompt: 'beta' }),
  ])

  assert.match(first.output, /answer:alpha/)
  assert.doesNotMatch(first.output, /answer:beta/)
  assert.match(second.output, /answer:beta/)
  assert.doesNotMatch(second.output, /answer:alpha/)
  assert.equal(first.processId, second.processId)
  assert.notEqual(first.sessionId, second.sessionId)
})

test('verifies initialize and session lifecycle without sending a model prompt', async () => {
  const client = makeClient('probe-only')
  const cwd = await temporaryWorkspace()

  const result = await client.verifyConnection({ cwd })

  assert.equal(result.protocolVersion, 1)
  assert.equal(typeof result.sessionId, 'string')
  assert.equal(typeof result.processId, 'number')
})

test('resolves the installed DSH batch wrapper to a direct shell-free process launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-launcher-'))
  temporaryRoots.push(root)
  const installation = path.join(root, 'DeepSeek Harness')
  const wrapper = path.join(installation, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
  const executable = path.join(installation, 'DeepSeek Harness.exe')
  const cli = path.join(installation, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  await mkdir(path.dirname(wrapper), { recursive: true })
  await mkdir(path.dirname(cli), { recursive: true })
  await writeFile(wrapper, '@echo off\n', 'utf8')
  await writeFile(executable, '', 'utf8')
  await writeFile(cli, '', 'utf8')

  const launch = resolveLaunchSpec(wrapper, ['--profile', 'acp'], 'win32')

  assert.deepEqual(launch, {
    command: executable,
    args: ['--expose-internals', cli, '--profile', 'acp'],
    shell: false,
  })
})

test('forces the DSH read-only policy and strips inherited credential variables', async () => {
  const client = makeClient('inspect-env', {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERPROFILE: process.env.USERPROFILE,
      DSH_PERMISSION_MODE: 'danger-full-access',
      OPENAI_API_KEY: 'codex-secret',
      CUSTOM_TOKEN: 'other-secret',
    },
  })
  const cwd = await temporaryWorkspace()

  const result = await client.runTask({ cwd, prompt: 'inspect child environment' })

  assert.match(result.output, /permission=read-only/)
  assert.match(result.output, /openai=<unset>/)
  assert.match(result.output, /custom=<unset>/)
})

test('rejects ACP permission requests instead of granting them', async () => {
  const client = makeClient('request-permission')
  const cwd = await temporaryWorkspace()

  const result = await client.runTask({ cwd, prompt: 'request an unsafe action' })

  assert.match(result.output, /permission-result=cancelled/)
})

test('sends session cancellation and closes the cancelled ACP session', async () => {
  const cwd = await temporaryWorkspace()
  const started = path.join(cwd, 'prompt-started.marker')
  const client = makeClient('hang-until-cancel', { args: [started] })
  const controller = new AbortController()
  const operation = client.runTask({ cwd, prompt: 'wait for cancellation', signal: controller.signal })
  await waitForFile(started)
  controller.abort(new Error('test cancellation'))

  const result = await operation
  assert.equal(result.stopReason, 'cancelled')
  assert.match(result.output, /cancelled by ACP session\/cancel/)
})

test('reports startup failures without leaking launcher details', async () => {
  const client = new AcpClient({
    commandPath: path.join(os.tmpdir(), 'missing-dsh-test-launcher.exe'),
    launcherArgs: [],
    startupTimeoutMs: 1000,
    stopTimeoutMs: 500,
  })
  clients.add(client)

  await assert.rejects(
    client.runTask({ cwd: await temporaryWorkspace(), prompt: 'never sent' }),
    error => error.kind === 'startup' && !error.message.includes('missing-dsh-test-launcher'),
  )
})

test('does not replay a failed prompt and can start a fresh ACP process on the next task', async () => {
  const root = await temporaryWorkspace()
  const marker = path.join(root, 'crashed-once.txt')
  const client = makeClient('crash-once', { args: [marker] })

  await assert.rejects(client.runTask({ cwd: root, prompt: 'first prompt' }))
  const result = await client.runTask({ cwd: root, prompt: 'second prompt' })

  assert.match(result.output, /answer:second prompt/)
  assert.doesNotMatch(result.output, /first prompt/)
})

test('reports a session-close timeout with the completed prompt output', async () => {
  const client = makeClient('hang-close', { stopTimeoutMs: 100 })
  const cwd = await temporaryWorkspace()

  await assert.rejects(
    client.runTask({ cwd, prompt: 'close timeout probe' }),
    error => error.kind === 'cleanup' && /answer:close timeout probe/.test(error.partialOutput),
  )
})

test('cancels in-flight sessions after transport loss and recovers on a fresh process', async () => {
  const cwd = await temporaryWorkspace()
  const markerPrefix = path.join(cwd, 'transport')
  const client = makeClient('disconnect-concurrent', { args: [markerPrefix], stopTimeoutMs: 100 })
  const waitingController = new AbortController()
  const disconnectingController = new AbortController()
  const waiting = client.runTask({ cwd, prompt: 'wait', signal: waitingController.signal })
  await waitForFile(`${markerPrefix}.wait.marker`)
  const disconnecting = client.runTask({ cwd, prompt: 'disconnect', signal: disconnectingController.signal })
  await waitForFile(`${markerPrefix}.disconnect.marker`)
  waitingController.abort()
  disconnectingController.abort()

  const cancelledRuns = await Promise.all([waiting, disconnecting])
  assert.deepEqual(cancelledRuns.map(run => run.stopReason), ['cancelled', 'cancelled'])

  const recovered = await client.runTask({ cwd, prompt: 'fresh request' })

  assert.match(recovered.output, /answer:fresh request/)
  assert.equal(await readFile(`${markerPrefix}.starts`, 'utf8'), '2')
})
