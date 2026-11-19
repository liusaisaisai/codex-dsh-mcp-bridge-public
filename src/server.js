import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DELEGATION_INPUT_SCHEMA, DELEGATION_RESULT_SCHEMA } from './delegate.js'

export function createBridgeServer({ delegate }) {
  const server = new McpServer({
    name: 'codex-dsh-mcp-bridge',
    version: '0.1.0',
  })

  server.registerTool('dsh_delegate', {
    title: 'Delegate analysis to DeepSeek Harness',
    description: 'Run one bounded, read-only analysis task in DeepSeek Harness and return a structured report for Codex review. Edit mode is currently disabled.',
    inputSchema: DELEGATION_INPUT_SCHEMA,
    outputSchema: DELEGATION_RESULT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input, extra) => {
    const result = await delegate.delegate(input, { signal: extra.signal })
    return {
      content: [{ type: 'text', text: result.summary }],
      structuredContent: result,
    }
  })

  return server
}
