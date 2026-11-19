# Codex DSH MCP Bridge

本项目提供一个本机 stdio MCP 服务，让 Codex 把有明确验收条件的只读分析任务交给 DeepSeek Harness (DSH)，再检查它返回的结构化报告。

## 状态与边界

- 仅支持 `analysis` 模式。`edit` 请求会被拒绝。
- 桥接器为 DSH 子进程设置 `DSH_PERMISSION_MODE=read-only`，并拒绝 ACP 权限请求。
- 工作区必须位于配置的白名单根目录内；项目适用的 `AGENTS.md` 会随任务提供。
- 多个独立任务可复用一个 ACP 进程并行运行，每个任务使用单独会话。
- 取消、超时和传输失败不会自动重放原提示词。会话关闭超时会返回 cleanup 错误，并保留已有部分输出。
- 输出解析支持 JSON 前后的简短说明文字及 JSON fenced block。未发现有效报告时会保留原始输出并标记检查结果未验证。
- DSH 权限模式和 ACP 请求拒绝属于应用层保护，不是 Windows 文件系统沙箱。不要把不可信目录加入白名单；编辑模式保持关闭。

## 兼容性

已在 Windows 上使用 DeepSeek Harness Desktop `0.2.0-rc.2`、捆绑的 `@deepseek-ai/dsh-desktop-host` `0.2.0-rc.2` 和 ACP protocol version 1 完成初始化、会话生命周期及只读分析验证。其他 DSH 版本尚未认证。升级 DSH 后请重新运行 ACP 冒烟检查；若启动器布局变化，更新配置并提交兼容性信息。

需要 Windows、Node.js 24 或更新版本、DeepSeek Harness 桌面版及 Codex CLI。

## 安装

```powershell
npm ci
$configDir = Join-Path $env:LOCALAPPDATA 'CodexDshBridge'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$configPath = Join-Path $configDir 'config.json'
if (Test-Path -LiteralPath $configPath) { throw "Configuration already exists: $configPath" }
Copy-Item -LiteralPath .\config.example.json -Destination $configPath
```

编辑 `%LOCALAPPDATA%\CodexDshBridge\config.json`，把示例中的启动器和工作区路径替换成实际绝对路径。工作区白名单只应包含可信的项目目录。

```powershell
$env:CODEX_DSH_BRIDGE_CONFIG = Join-Path $env:LOCALAPPDATA 'CodexDshBridge\config.json'
node .\scripts\acp-smoke.js
.\scripts\register-codex-mcp.ps1
```

注册脚本会检查 DSH ACP profile、配置和依赖。如果用户级 Codex 配置里已有 `dsh_bridge`，脚本会停止且不覆盖。注册后重启 Codex，在新会话中加载工具。

## 调用示例

```json
{
  "task": "Review ACP session cleanup in src/acp-client.js",
  "workspace": "C:\\Projects\\example-project",
  "mode": "analysis",
  "allowed_paths": ["src/acp-client.js", "test/acp-client.test.js"],
  "acceptance_criteria": [
    "Identify concrete lifecycle risks with file references",
    "Do not modify files or run commands"
  ]
}
```

工具返回状态、摘要、分析细节、检查结果和未解决问题。`agent_reported_files` 是 DSH 自报内容，不是文件系统审计记录；Codex 仍需独立核对结果。

## 更新与卸载

更新代码后，在仓库目录运行：

```powershell
git pull --ff-only
npm ci
npm test
```

卸载 MCP 注册：

```powershell
codex mcp remove dsh_bridge
```

确认不再需要本机设置后，可删除 `%LOCALAPPDATA%\CodexDshBridge\config.json` 和本地仓库目录。

更多运维与故障排查见 [运维说明](docs/operations.md)。本项目与 DeepSeek Harness 及 OpenAI Codex 均无隶属关系。
