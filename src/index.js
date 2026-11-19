#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AcpClient } from './acp-client.js'
import { loadConfig } from './config.js'
import { DshDelegate } from './delegate.js'
import { createBridgeServer } from './server.js'

let acpClient

async function main() {
  const config = await loadConfig()
  acpClient = new AcpClient({ commandPath: config.dshCommandPath })
  const delegate = new DshDelegate({ config, acpClient })
  const server = createBridgeServer({ delegate })
  const transport = new StdioServerTransport()
  let shutdownPromise

  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await server.close().catch(() => {})
      await acpClient.dispose()
    })()
    return shutdownPromise
  }

  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  process.stdin.once('end', () => { void shutdown() })
  await server.connect(transport)
}

main().catch(async error => {
  await acpClient?.dispose().catch(() => {})
  process.stderr.write(`[dsh-bridge] startup failed: ${error.message}\n`)
  process.exitCode = 1
})
