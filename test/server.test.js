import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createBridgeServer } from '../src/server.js'

const active = []

after(async () => {
  await Promise.all(active.map(async ({ client, server }) => {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }))
})

test('registers dsh_delegate and returns a validated structured MCP result', async () => {
  const expected = {
    task_id: 'e4a1ce93-95f6-44da-a2ec-3ebf15e746dc',
    status: 'completed',
    summary: 'Analysis complete.',
    details: 'No issues found.',
    files_changed: [],
    agent_reported_files: [],
    checks: [],
    worktree_path: null,
    baseline_commit: null,
    unresolved_questions: [],
    error_kind: null,
  }
  const delegate = {
    async delegate(input, { signal }) {
      assert.equal(input.task, 'Summarize the project entry point.')
      assert.equal(signal.aborted, false)
      return expected
    },
  }
  const server = createBridgeServer({ delegate })
  const client = new Client({ name: 'dsh-bridge-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  active.push({ client, server })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = await client.listTools()
  const tool = listed.tools.find(item => item.name === 'dsh_delegate')
  assert.equal(listed.tools.length, 1)
  assert.ok(tool)
  assert.match(tool.description, /analysis/i)

  const called = await client.callTool({
    name: 'dsh_delegate',
    arguments: {
      task: 'Summarize the project entry point.',
      workspace: process.cwd(),
      mode: 'analysis',
      acceptance_criteria: ['Mention the entry point.'],
    },
  })

  assert.equal(called.structuredContent.task_id, expected.task_id)
  assert.equal(called.structuredContent.summary, 'Analysis complete.')
})
