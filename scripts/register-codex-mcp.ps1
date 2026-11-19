[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Resolve-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction Stop
    if (-not $command.Source) {
        throw "Could not resolve an executable path for '$Name'."
    }
    return $command.Source
}

$nodePath = Resolve-CommandPath 'node'
$codexPath = Resolve-CommandPath 'codex'
if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is not set.'
}

$bridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entrypoint = Join-Path $bridgeRoot 'src\index.js'
$dependencies = Join-Path $bridgeRoot 'node_modules\@modelcontextprotocol\sdk'
$configPath = Join-Path $env:LOCALAPPDATA 'CodexDshBridge\config.json'

foreach ($requiredPath in @($entrypoint, $dependencies, $configPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required bridge file or directory is missing: $requiredPath"
    }
}

try {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "Bridge configuration is not valid JSON: $configPath"
}

if (-not (Test-Path -LiteralPath $config.dshCommandPath -PathType Leaf)) {
    throw "Configured DSH launcher does not exist: $($config.dshCommandPath)"
}
if (@($config.allowedWorkspaceRoots).Count -eq 0) {
    throw 'At least one allowedWorkspaceRoots entry is required.'
}
foreach ($root in $config.allowedWorkspaceRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Configured workspace root does not exist: $root"
    }
}

& $config.dshCommandPath --profile acp --help *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'The configured DSH launcher could not load the ACP profile.'
}

$serverListOutput = & $codexPath mcp list --json
if ($LASTEXITCODE -ne 0) {
    throw 'Could not read the current Codex MCP server list.'
}
try {
    $servers = ($serverListOutput -join "`n") | ConvertFrom-Json
} catch {
    throw 'Codex returned an invalid MCP server list.'
}
if (@($servers | Where-Object { $_.name -eq 'dsh_bridge' }).Count -gt 0) {
    throw "An MCP server named 'dsh_bridge' already exists; it was not changed."
}

$configEnvironment = "CODEX_DSH_BRIDGE_CONFIG=$configPath"
& $codexPath mcp add dsh_bridge --env $configEnvironment -- $nodePath $entrypoint
if ($LASTEXITCODE -ne 0) {
    throw 'Codex could not register dsh_bridge.'
}

Write-Output "Registered dsh_bridge using $entrypoint"
