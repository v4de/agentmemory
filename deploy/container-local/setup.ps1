# agentmemory local container setup (Podman or Docker)
# Builds the image, creates volumes, starts the container, and prints
# the MCP config snippet for your chosen client.
#
# The HMAC secret is generated inside the container on first boot and
# stored in a dedicated secrets volume. The shim container mounts that
# same volume read-only. The secret never leaves the volume layer.
#
# Usage:
#   cd deploy/container-local
#   .\setup.ps1                                    # auto-detect engine, show all configs
#   .\setup.ps1 -Engine podman -Client mcp-gateway
#   .\setup.ps1 -Engine docker -Client vscode
#   .\setup.ps1 -Client claude-code

param(
    [ValidateSet("auto", "podman", "docker")]
    [string]$Engine = "auto",

    [ValidateSet("all", "mcp-gateway", "vscode", "claude-code", "cursor", "kiro", "codex")]
    [string]$Client = "all"
)

$ErrorActionPreference = "Stop"

# --- Detect container engine ---
if ($Engine -eq "auto") {
    if (Get-Command podman -ErrorAction SilentlyContinue) {
        $Engine = "podman"
    } elseif (Get-Command docker -ErrorAction SilentlyContinue) {
        $Engine = "docker"
    } else {
        Write-Error "Neither podman nor docker found on PATH. Install one and retry."
        exit 1
    }
}
Write-Host "Using container engine: $Engine" -ForegroundColor Cyan

$ImageName = "agentmemory"
$ContainerName = "agentmemory"
$DataVolume = "agentmemory-data"
$SecretsVolume = "agentmemory-secrets"
$ShimImageName = "agentmemory-mcp-shim"
$RestPort = 3111
$ViewerPort = 3113

# Podman requires --load to store the image in the local registry; docker does not.
$BuildArgs = @("build", "-t", $ImageName, "-f", "Dockerfile", ".")
if ($Engine -eq "podman") { $BuildArgs = @("build", "--load", "-t", $ImageName, "-f", "Dockerfile", ".") }

Write-Host "`n=== Building agentmemory server image ===" -ForegroundColor Cyan
& $Engine @BuildArgs

$ShimBuildArgs = @("build", "-t", $ShimImageName, "-f", "Dockerfile.mcp-shim", ".")
if ($Engine -eq "podman") { $ShimBuildArgs = @("build", "--load", "-t", $ShimImageName, "-f", "Dockerfile.mcp-shim", ".") }

Write-Host "`n=== Building MCP shim image (for gateway backend) ===" -ForegroundColor Cyan
& $Engine @ShimBuildArgs

Write-Host "`n=== Creating persistent volumes ===" -ForegroundColor Cyan
foreach ($vol in @($DataVolume, $SecretsVolume)) {
    & $Engine volume inspect $vol 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $Engine volume create $vol
        Write-Host "Created volume: $vol"
    } else {
        Write-Host "Volume already exists: $vol"
    }
}

# Stop existing container if running
$existing = & $Engine ps -a --filter "name=^${ContainerName}$" --format "{{.ID}}" 2>$null
if ($existing) {
    Write-Host "`n=== Stopping existing container ===" -ForegroundColor Yellow
    & $Engine rm -f $ContainerName
}

Write-Host "`n=== Starting agentmemory container ===" -ForegroundColor Cyan
& $Engine run -d `
    --name $ContainerName `
    --restart unless-stopped `
    -p "127.0.0.1:${RestPort}:3111" `
    -p "127.0.0.1:${ViewerPort}:3113" `
    -v "${DataVolume}:/data" `
    -v "${SecretsVolume}:/secrets" `
    $ImageName

Write-Host "`n=== Waiting for startup ===" -ForegroundColor Cyan
$health = $null
for ($i = 0; $i -lt 15; $i++) {
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:${RestPort}/agentmemory/livez" -TimeoutSec 3
        break
    } catch {
        Start-Sleep -Seconds 4
    }
}
if ($health) {
    Write-Host "agentmemory is healthy!" -ForegroundColor Green
} else {
    Write-Host "WARNING: Health check failed. Check logs with: $Engine logs $ContainerName" -ForegroundColor Red
}

# Determine the host address containers use to reach the host
if ($Engine -eq "podman") {
    $HostAddr = "host.containers.internal"
} else {
    $HostAddr = "host.docker.internal"
}

Write-Host "`n================================================================" -ForegroundColor Green
Write-Host "agentmemory is running!" -ForegroundColor Green
Write-Host "  Engine:    $Engine" -ForegroundColor White
Write-Host "  REST API:  http://localhost:$RestPort" -ForegroundColor White
Write-Host "  Viewer:    http://localhost:$ViewerPort" -ForegroundColor White
Write-Host "  Secret:    inside '$SecretsVolume' volume (never leaves volume layer)" -ForegroundColor White
Write-Host "================================================================" -ForegroundColor Green

# --- Print client-specific MCP config ---

function Show-McpServersJson {
    param([string]$Label, [string]$FilePath)
    Write-Host "`n=== $Label ===" -ForegroundColor Cyan
    Write-Host @"

{
  "mcpServers": {
    "agentmemory": {
      "command": "$Engine",
      "args": [
        "run", "--rm", "-i",
        "-e", "AGENTMEMORY_URL=http://${HostAddr}:$RestPort",
        "-v", "${SecretsVolume}:/run/secrets:ro",
        "$ShimImageName"
      ]
    }
  }
}

"@ -ForegroundColor Yellow
    Write-Host "  File: $FilePath" -ForegroundColor Gray
}

function Show-GatewayConfig {
    Write-Host "`n=== MCP Gateway (gateway.yaml under servers:) ===" -ForegroundColor Cyan
    Write-Host @"

  agentmemory:
    transport: stdio
    command: $Engine
    args:
      - run
      - --rm
      - -i
      - -e
      - AGENTMEMORY_URL=http://${HostAddr}:$RestPort
      - -v
      - ${SecretsVolume}:/run/secrets:ro
      - $ShimImageName
    description: "Agent persistent memory — save, recall, search, sessions"
    enabled: true

"@ -ForegroundColor Yellow
    Write-Host "  File: ~/.mcp-gateway/gateway.yaml" -ForegroundColor Gray
}

function Show-VscodeConfig {
    Write-Host "`n=== VS Code / GitHub Copilot (.vscode/mcp.json) ===" -ForegroundColor Cyan
    Write-Host @"

{
  "servers": {
    "agentmemory": {
      "command": "$Engine",
      "args": [
        "run", "--rm", "-i",
        "-e", "AGENTMEMORY_URL=http://${HostAddr}:$RestPort",
        "-v", "${SecretsVolume}:/run/secrets:ro",
        "$ShimImageName"
      ]
    }
  }
}

"@ -ForegroundColor Yellow
    Write-Host "  File: .vscode/mcp.json (workspace) or ~/.vscode/mcp.json (global)" -ForegroundColor Gray
}

function Show-CodexConfig {
    Write-Host "`n=== Codex CLI (~/.codex/config.toml) ===" -ForegroundColor Cyan
    Write-Host @"

# Option 1: codex mcp add
codex mcp add agentmemory -- $Engine run --rm -i -e AGENTMEMORY_URL=http://${HostAddr}:$RestPort -v ${SecretsVolume}:/run/secrets:ro $ShimImageName

# Option 2: manual TOML (~/.codex/config.toml)
[mcp_servers.agentmemory]
command = "$Engine"
args = ["run", "--rm", "-i", "-e", "AGENTMEMORY_URL=http://${HostAddr}:$RestPort", "-v", "${SecretsVolume}:/run/secrets:ro", "$ShimImageName"]

"@ -ForegroundColor Yellow
    Write-Host "  File: ~/.codex/config.toml" -ForegroundColor Gray
}

Write-Host "`n=== Client MCP Configuration ===" -ForegroundColor Cyan

switch ($Client) {
    "mcp-gateway"  { Show-GatewayConfig }
    "vscode"       { Show-VscodeConfig }
    "claude-code"  { Show-McpServersJson "Claude Code (~/.claude.json)" "~/.claude.json" }
    "cursor"       { Show-McpServersJson "Cursor (~/.cursor/mcp.json)" "~/.cursor/mcp.json" }
    "kiro"         { Show-McpServersJson "Kiro (~/.kiro/settings/mcp.json)" "~/.kiro/settings/mcp.json (user) or .kiro/settings/mcp.json (workspace)" }
    "codex"        { Show-CodexConfig }
    "all" {
        Show-GatewayConfig
        Show-McpServersJson "Claude Code (~/.claude.json)" "~/.claude.json"
        Show-VscodeConfig
        Show-McpServersJson "Cursor (~/.cursor/mcp.json)" "~/.cursor/mcp.json"
        Show-McpServersJson "Kiro (~/.kiro/settings/mcp.json)" "~/.kiro/settings/mcp.json (user) or .kiro/settings/mcp.json (workspace)"
        Show-CodexConfig
    }
}

Write-Host @"

NOTE: The secret lives only in the '$SecretsVolume' volume.
      Both the server and shim mount it — no secret in config files or env vars.
      To rotate: $Engine volume rm $SecretsVolume && re-run this script.
"@ -ForegroundColor Gray

Write-Host "`n=== To verify ===" -ForegroundColor Cyan
Write-Host "  curl http://localhost:${RestPort}/agentmemory/livez"
Write-Host "  $Engine logs $ContainerName"
Write-Host ""
