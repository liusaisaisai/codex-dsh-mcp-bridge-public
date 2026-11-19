import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const behavior = process.argv[2] ?? 'echo'
const crashMarker = process.argv[3]
const sessions = new Map()
const pendingPrompts = new Map()

if (behavior === 'disconnect-concurrent' && crashMarker !== undefined) {
  const startsFile = `${crashMarker}.starts`
  const starts = existsSync(startsFile) ? Number(readFileSync(startsFile, 'utf8')) : 0
  writeFileSync(startsFile, String(starts + 1), 'utf8')
}

agent({ name: 'codex-dsh-bridge-test-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID()
    sessions.set(sessionId, { cwd: params.cwd })
    return { sessionId }
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    if (behavior === 'hang-close') return new Promise(() => {})
    sessions.delete(params.sessionId)
    return {}
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (behavior === 'probe-only') process.exit(19)
    const input = params.prompt
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')

    if (behavior === 'disconnect-concurrent') {
      const label = input.trim()
      writeFileSync(`${crashMarker}.${label}.marker`, 'started\n', 'utf8')
      if (label === 'disconnect') process.stdout.end()
      if (label === 'wait' || label === 'disconnect') {
        await new Promise(resolve => pendingPrompts.set(params.sessionId, resolve))
      }
    }

    if (behavior === 'crash-once' && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, 'crashed\n', 'utf8')
      process.exit(17)
    }

    if (behavior === 'hang-until-cancel') {
      if (crashMarker !== undefined) writeFileSync(crashMarker, 'prompt started\n', 'utf8')
      await new Promise(resolve => pendingPrompts.set(params.sessionId, resolve))
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'cancelled by ACP session/cancel' },
        },
      })
      return { stopReason: 'cancelled' }
    }

    let answer
    if (behavior === 'inspect-env') {
      answer = [
        `permission=${process.env.DSH_PERMISSION_MODE ?? '<unset>'}`,
        `openai=${process.env.OPENAI_API_KEY ?? '<unset>'}`,
        `custom=${process.env.CUSTOM_TOKEN ?? '<unset>'}`,
      ].join('|')
    } else if (behavior === 'inspect-cwd') {
      answer = `cwd=${sessions.get(params.sessionId)?.cwd ?? '<unknown>'}`
    } else {
      answer = `answer:${input}:pid=${process.pid}`
    }

    if (behavior === 'request-permission') {
      const decision = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'write-file' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      answer += `|permission-result=${decision.outcome.outcome}`
    }

    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: answer },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    pendingPrompts.get(params.sessionId)?.()
    pendingPrompts.delete(params.sessionId)
  })
  .connect(ndJsonStream(
    NodeWritable.toWeb(process.stdout),
    NodeReadable.toWeb(process.stdin),
  ))
