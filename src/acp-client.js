import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { promisify } from 'node:util'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const execFileAsync = promisify(execFile)
const ABORTED = Symbol('aborted')
const SAFE_ENV_NAMES = new Set([
  'APPDATA',
  'COMSPEC',
  'DSH_HOME',
  'ELECTRON_RUN_AS_NODE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TZ',
  'USERPROFILE',
  'WINDIR',
])

export class AcpClientError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AcpClientError'
    this.kind = kind
    this.partialOutput = options.partialOutput ?? ''
  }
}

export function sanitizeChildEnvironment(source = process.env) {
  const result = {}
  for (const [name, value] of Object.entries(source)) {
    if (SAFE_ENV_NAMES.has(name.toUpperCase()) && typeof value === 'string') {
      result[name] = value
    }
  }

  result.ELECTRON_RUN_AS_NODE = '1'
  result.DSH_PERMISSION_MODE = 'read-only'
  return result
}

export function resolveLaunchSpec(commandPath, launcherArgs, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(commandPath)) {
    return { command: commandPath, args: [...launcherArgs], shell: false }
  }

  if (path.basename(commandPath).toLocaleLowerCase('en-US') !== 'dsh.cmd') {
    throw new AcpClientError('startup', 'The configured Windows batch launcher is not a supported DSH launcher.')
  }

  const installationRoot = path.resolve(path.dirname(commandPath), '..', '..', '..', '..')
  const executable = path.join(installationRoot, 'DeepSeek Harness.exe')
  const cli = path.join(
    installationRoot,
    'resources',
    'app',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  )
  if (!existsSync(executable) || !existsSync(cli)) {
    throw new AcpClientError('startup', 'The installed DSH launcher layout could not be resolved.')
  }

  return {
    command: executable,
    args: ['--expose-internals', cli, ...launcherArgs],
    shell: false,
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function requestWithTimeout(agent, method, params, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      agent.request(method, params, { cancellationSignal: AbortSignal.timeout(timeoutMs) }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ACP request timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)

  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      resolve(value)
    }
    const onExit = () => finish(true)
    const onError = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function terminateProcessTree(child) {
  if (child.pid === undefined) return

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 3000,
        windowsHide: true,
      })
    } catch {
      child.kill()
    }
    return
  }

  child.kill('SIGTERM')
  if (!(await waitForExit(child, 1500))) child.kill('SIGKILL')
}

function responseText(content) {
  if (content?.type === 'text' && typeof content.text === 'string') return content.text
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }
  return ''
}

export class AcpClient {
  #commandPath
  #launcherArgs
  #env
  #spawnProcess
  #startupTimeoutMs
  #stopTimeoutMs
  #starting
  #child
  #connection
  #agent
  #activeRuns = new Map()
  #disposed = false
  #disposePromise

  constructor({
    commandPath,
    launcherArgs = ['--profile', 'acp'],
    env = process.env,
    spawnProcess = spawn,
    startupTimeoutMs = 15000,
    stopTimeoutMs = 3000,
  }) {
    this.#commandPath = commandPath
    this.#launcherArgs = [...launcherArgs]
    this.#env = env
    this.#spawnProcess = spawnProcess
    this.#startupTimeoutMs = startupTimeoutMs
    this.#stopTimeoutMs = stopTimeoutMs
  }

  async runTask({ cwd, prompt, signal }) {
    if (this.#disposed) throw new AcpClientError('closed', 'DSH ACP client is closed')
    if (signal?.aborted) return this.#cancelledResult('', undefined, undefined)

    await this.#ensureStarted()
    if (signal?.aborted) return this.#cancelledResult('', undefined, this.#child?.pid)

    const agent = this.#agent
    const child = this.#child
    if (agent === undefined || child === undefined) {
      throw new AcpClientError('transport', 'DSH ACP connection is unavailable')
    }

    let session
    try {
      session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] }, {
        ...(signal === undefined ? {} : { cancellationSignal: signal }),
      })
    } catch (error) {
      if (signal?.aborted) return this.#cancelledResult('', undefined, child.pid)
      throw new AcpClientError('transport', 'DSH ACP could not create a session', { cause: error })
    }

    if (typeof session?.sessionId !== 'string' || session.sessionId.length === 0) {
      throw new AcpClientError('protocol', 'DSH ACP returned an invalid session id')
    }

    const state = { chunks: [], permissionDenied: false }
    this.#activeRuns.set(session.sessionId, state)
    let cancelPromise
    const abortTask = () => {
      cancelPromise ??= agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {})
      return cancelPromise
    }
    let abortListener
    let promptPromise
    let result
    let failure

    try {
      if (signal?.aborted) {
        abortTask()
        result = this.#cancelledResult('', session.sessionId, child.pid)
      } else {
        const abortPromise = signal === undefined
          ? undefined
          : new Promise(resolve => {
            abortListener = () => {
              abortTask()
              resolve(ABORTED)
            }
            signal.addEventListener('abort', abortListener, { once: true })
            if (signal.aborted) abortListener()
          })

        promptPromise = agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: prompt }],
        })

        const promptResponse = abortPromise === undefined
          ? await promptPromise
          : await Promise.race([promptPromise, abortPromise])

        if (promptResponse === ABORTED || signal?.aborted) {
          await abortTask()
          await Promise.race([
            promptPromise.then(() => undefined, () => undefined),
            delay(this.#stopTimeoutMs),
          ])
          result = this.#cancelledResult(state.chunks.join(''), session.sessionId, child.pid)
        } else {
          result = {
            sessionId: session.sessionId,
            processId: child.pid,
            output: state.chunks.join(''),
            stopReason: promptResponse.stopReason,
            permissionDenied: state.permissionDenied,
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        abortTask()
        result = this.#cancelledResult(state.chunks.join(''), session.sessionId, child.pid)
      } else {
        failure = new AcpClientError('transport', 'DSH ACP prompt failed', {
          cause: error,
          partialOutput: state.chunks.join(''),
        })
      }
    } finally {
      if (signal !== undefined && abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener)
      }
      try {
        await requestWithTimeout(
          agent,
          methods.agent.session.close,
          { sessionId: session.sessionId },
          this.#stopTimeoutMs,
        )
      } catch (error) {
        if (failure === undefined && result?.stopReason !== 'cancelled') {
          failure = new AcpClientError('cleanup', 'DSH ACP could not close the task session', {
            cause: error,
            partialOutput: state.chunks.join(''),
          })
        }
      } finally {
        this.#activeRuns.delete(session.sessionId)
      }
    }

    if (failure !== undefined) throw failure
    return result
  }

  async verifyConnection({ cwd }) {
    if (this.#disposed) throw new AcpClientError('closed', 'DSH ACP client is closed')
    await this.#ensureStarted()
    const agent = this.#agent
    const child = this.#child
    if (agent === undefined || child === undefined) {
      throw new AcpClientError('transport', 'DSH ACP connection is unavailable')
    }

    let session
    try {
      session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] }, {
        cancellationSignal: AbortSignal.timeout(this.#startupTimeoutMs),
      })
    } catch (error) {
      throw new AcpClientError('startup', 'DSH ACP could not create a smoke-test session', { cause: error })
    }
    if (typeof session?.sessionId !== 'string' || session.sessionId.length === 0) {
      throw new AcpClientError('protocol', 'DSH ACP returned an invalid smoke-test session id')
    }

    try {
      await requestWithTimeout(
        agent,
        methods.agent.session.close,
        { sessionId: session.sessionId },
        this.#stopTimeoutMs,
      )
    } catch (error) {
      throw new AcpClientError('cleanup', 'DSH ACP could not close the smoke-test session', { cause: error })
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      processId: child.pid,
    }
  }

  #cancelledResult(output, sessionId, processId) {
    return {
      sessionId,
      processId,
      output,
      stopReason: 'cancelled',
      permissionDenied: false,
    }
  }

  async #ensureStarted() {
    if (this.#connection !== undefined && !this.#connection.signal.aborted && this.#child !== undefined) {
      return
    }
    if (this.#starting !== undefined) return this.#starting
    if (this.#disposed) throw new AcpClientError('closed', 'DSH ACP client is closed')

    this.#starting = this.#start()
    try {
      await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #start() {
    if (this.#child !== undefined || this.#connection !== undefined) {
      await this.#stopCurrentProcess()
    }

    let child
    try {
      const launch = resolveLaunchSpec(this.#commandPath, this.#launcherArgs)
      child = this.#spawnProcess(launch.command, launch.args, {
        cwd: process.cwd(),
        env: sanitizeChildEnvironment(this.#env),
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: launch.shell,
        windowsHide: true,
      })
    } catch (error) {
      throw new AcpClientError('startup', 'DSH ACP process could not start', { cause: error })
    }

    this.#child = child
    let rejectProcessFailure
    const processFailure = new Promise((_, reject) => { rejectProcessFailure = reject })
    processFailure.catch(() => {})
    const processFailureError = kind => new AcpClientError(
      kind,
      'DSH ACP process exited before the request completed',
    )

    child.once('error', error => {
      rejectProcessFailure(new AcpClientError('startup', 'DSH ACP process could not start', { cause: error }))
      this.#clearProcess(child)
    })
    child.once('exit', () => {
      rejectProcessFailure(processFailureError('transport'))
      this.#clearProcess(child)
    })

    const app = createAcpClientApp({ name: 'codex-dsh-mcp-bridge' })
      .onNotification(methods.client.session.update, ({ params }) => {
        const state = this.#activeRuns.get(params.sessionId)
        if (state === undefined) return
        const update = params.update
        if (update.sessionUpdate === 'agent_message_chunk') {
          state.chunks.push(responseText(update.content))
        }
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const state = this.#activeRuns.get(params.sessionId)
        if (state !== undefined) state.permissionDenied = true
        return { outcome: { outcome: 'cancelled' } }
      })

    let connection
    try {
      connection = app.connect(ndJsonStream(
        NodeWritable.toWeb(child.stdin),
        NodeReadable.toWeb(child.stdout),
      ))
      this.#connection = connection
      this.#agent = connection.agent
      void connection.closed.then(() => this.#clearConnection(connection))

      let timeout
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new AcpClientError('startup', 'DSH ACP initialization timed out')),
          this.#startupTimeoutMs)
      })
      try {
        const initialized = await Promise.race([
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
          processFailure,
          timeoutPromise,
        ])
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new AcpClientError('protocol', 'DSH ACP returned an unsupported protocol version')
        }
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      await this.#stopCurrentProcess()
      if (error instanceof AcpClientError) throw error
      throw new AcpClientError('startup', 'DSH ACP initialization failed', { cause: error })
    }
  }

  #clearProcess(child) {
    if (this.#child !== child) return
    this.#child = undefined
    if (this.#connection?.signal.aborted) {
      this.#connection = undefined
      this.#agent = undefined
    }
  }

  #clearConnection(connection) {
    if (this.#connection !== connection) return
    this.#connection = undefined
    this.#agent = undefined
  }

  async #stopCurrentProcess() {
    const child = this.#child
    const connection = this.#connection
    this.#child = undefined
    this.#connection = undefined
    this.#agent = undefined

    if (connection !== undefined) {
      try {
        await connection.close()
      } catch {
        // Process teardown below remains authoritative.
      }
    }
    if (child === undefined) return

    try {
      if (child.stdin !== null && !child.stdin.destroyed) child.stdin.end()
    } catch {
      // The child may already have exited.
    }

    if (await waitForExit(child, this.#stopTimeoutMs)) return
    await terminateProcessTree(child)
    await waitForExit(child, 1000)
  }

  async dispose() {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.#disposePromise = (async () => {
      try {
        await this.#starting
      } catch {
        // Startup owns its own rollback.
      }
      await this.#stopCurrentProcess()
    })()
    return this.#disposePromise
  }
}
