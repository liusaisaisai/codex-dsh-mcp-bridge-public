# Operations

## Compatibility

The bridge was verified on Windows with DeepSeek Harness Desktop `0.2.0-rc.2`, bundled `@deepseek-ai/dsh-desktop-host` `0.2.0-rc.2`, and ACP protocol version 1. The installed launcher exposes `--profile acp`; the bridge also resolves the bundled CLI at `resources\app\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`. Other DSH versions are not certified. Re-run the smoke test after a DSH upgrade.

## Configuration

The default file is `%LOCALAPPDATA%\CodexDshBridge\config.json`. Set `CODEX_DSH_BRIDGE_CONFIG` to an absolute path to override it.

```json
{
  "dshCommandPath": "C:\\Path\\To\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd",
  "allowedWorkspaceRoots": [
    "C:\\Projects",
    "D:\\Projects"
  ],
  "maxConcurrentTasks": 3,
  "defaultTimeoutSeconds": 900,
  "maxTimeoutSeconds": 3600
}
```

Replace the example paths with existing absolute paths. Keep the roots limited to trusted project directories. Workspace paths and requested `allowed_paths` are physically resolved; traversal and links escaping the workspace are rejected. Missing or unreadable applicable `AGENTS.md` files fail closed.

## Install

From the repository root:

```powershell
npm ci
$configDir = Join-Path $env:LOCALAPPDATA 'CodexDshBridge'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$configPath = Join-Path $configDir 'config.json'
if (Test-Path -LiteralPath $configPath) { throw "Configuration already exists: $configPath" }
Copy-Item -LiteralPath .\config.example.json -Destination $configPath
```

Edit the copied configuration, then run:

```powershell
$env:CODEX_DSH_BRIDGE_CONFIG = Join-Path $env:LOCALAPPDATA 'CodexDshBridge\config.json'
node .\scripts\acp-smoke.js
.\scripts\register-codex-mcp.ps1
```

The smoke test performs ACP initialize, session creation, and session close without sending a model prompt. The registration script verifies the DSH ACP profile and stops if a `dsh_bridge` entry already exists. Restart Codex after registration.

## Upgrade

The MCP entry points to the local checkout. From that checkout:

```powershell
git pull --ff-only
npm ci
npm test
```

Re-run `node .\scripts\acp-smoke.js` after changing the DSH installation. If the checkout path changes, inspect the existing MCP entry with `codex mcp get dsh_bridge`; the registration script will not overwrite it. To register the new path, remove the old entry explicitly and run the registration script again.

## Uninstall

```powershell
codex mcp remove dsh_bridge
```

Optionally remove `%LOCALAPPDATA%\CodexDshBridge\config.json` and the local checkout after confirming they are no longer needed.

## Permission Boundary

- The child process receives an environment allowlist; inherited API-key and arbitrary token variables are excluded, and `DSH_PERMISSION_MODE=read-only` is forced.
- ACP permission requests are answered with `cancelled`; tests verify that the bridge does not grant them.
- The bridge does not provide Windows ACL isolation, a restricted token, or a job-object filesystem sandbox. The DSH mode and prompt are application-level controls. Keep edit mode disabled and use trusted workspaces only.
- If the shared ACP transport drops, in-flight tool tasks are cancelled by their configured timeout or caller cancellation; a later task starts a fresh process. Prompts are never automatically replayed.
- A session-close timeout returns a cleanup failure with partial output. A failed close may leave agent-side session state until the DSH process exits.
- DSH occasionally emits prose before its JSON report. The parser extracts the first schema-valid JSON object; when none is found, the raw output is preserved and requested checks remain unverified.

## Verification

```powershell
npm test
npm audit --omit=dev
```

The tests cover workspace boundaries, read-only environment policy, ACP permission denial, close timeout, concurrent transport loss and recovery, and report parsing. The live ACP smoke test verifies protocol/session setup; it does not prove OS-level write isolation.

## Troubleshooting

- `DSH launcher does not exist`: check `dshCommandPath` in the user config.
- `installed DSH launcher layout could not be resolved`: check that the installation contains `DeepSeek Harness.exe` and the bundled CLI path listed above.
- ACP profile or initialization errors: load the user config and run `& $config.dshCommandPath --profile acp --help`.
- `workspace is outside configured workspace roots`: add the specific trusted project root; do not use a whole-drive root merely to bypass validation.
- `invalid_scope`: ensure requested paths exist and are relative to the workspace, and that no junction or symbolic link escapes it.
- An existing `dsh_bridge` entry is never replaced by the registration script. Inspect it with `codex mcp get dsh_bridge` before changing configuration.
