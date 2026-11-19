import { AcpClient } from '../src/acp-client.js'
import { loadConfig } from '../src/config.js'

let client

try {
  const config = await loadConfig()
  client = new AcpClient({ commandPath: config.dshCommandPath })
  const result = await client.verifyConnection({ cwd: config.allowedWorkspaceRoots[0] })
  process.stdout.write(`${JSON.stringify({ status: 'ok', protocolVersion: result.protocolVersion, sessionClosed: true })}\n`)
} catch (error) {
  process.stderr.write(`[dsh-bridge] ACP smoke test failed: ${error.kind ?? 'error'}\n`)
  process.exitCode = 1
} finally {
  await client?.dispose()
}
