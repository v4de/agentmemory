# agentmemory Podman local setup
# Builds the image, creates volumes, starts the container, and prints
# the gateway.yaml snippet for MCP Gateway integration.
#
# The HMAC secret is generated inside the container on first boot and
# stored in a dedicated secrets volume. The shim container mounts that
# same volume read-only. The secret never leaves the volume layer.
#
# Usage:
#   cd d:\repo\agentmemory\deploy\podman-local
#   .\setup.ps1

$ErrorActionPreference = "Stop"

$ImageName = "agentmemory"
$ContainerName = "agentmemory"
$DataVolume = "agentmemory-data"
$SecretsVolume = "agentmemory-secrets"
$ShimImageName = "agentmemory-mcp-shim"
$RestPort = 3111
$ViewerPort = 3113

Write-Host "`n=== Building agentmemory server image ===" -ForegroundColor Cyan
podman build --load -t $ImageName -f Dockerfile .

Write-Host "`n=== Building MCP shim image (for gateway backend) ===" -ForegroundColor Cyan
podman build --load -t $ShimImageName -f Dockerfile.mcp-shim .

Write-Host "`n=== Creating persistent volumes ===" -ForegroundColor Cyan
foreach ($vol in @($DataVolume, $SecretsVolume)) {
    podman volume inspect $vol 2>$null
    if ($LASTEXITCODE -ne 0) {
        podman volume create $vol
        Write-Host "Created volume: $vol"
    } else {
        Write-Host "Volume already exists: $vol"
    }
}

# Stop existing container if running
$existing = podman ps -a --filter "name=^${ContainerName}$" --format "{{.ID}}" 2>$null
if ($existing) {
    Write-Host "`n=== Stopping existing container ===" -ForegroundColor Yellow
    podman rm -f $ContainerName
}

Write-Host "`n=== Starting agentmemory container ===" -ForegroundColor Cyan
podman run -d `
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
        $health = Invoke-RestMethod -Uri "http://localhost:${RestPort}/agentmemory/health" -TimeoutSec 3
        break
    } catch {
        Start-Sleep -Seconds 4
    }
}
if ($health) {
    Write-Host "agentmemory is healthy!" -ForegroundColor Green
} else {
    Write-Host "WARNING: Health check failed. Check logs with: podman logs $ContainerName" -ForegroundColor Red
}

Write-Host "`n================================================================" -ForegroundColor Green
Write-Host "agentmemory is running!" -ForegroundColor Green
Write-Host "  REST API:  http://localhost:$RestPort" -ForegroundColor White
Write-Host "  Viewer:    http://localhost:$ViewerPort" -ForegroundColor White
Write-Host "  Secret:    inside '$SecretsVolume' volume (never leaves volume layer)" -ForegroundColor White
Write-Host "================================================================" -ForegroundColor Green

Write-Host "`n=== Gateway backend config (add to ~/.mcp-gateway/gateway.yaml under servers:) ===" -ForegroundColor Cyan
Write-Host @"

  agentmemory:
    transport: stdio
    command: docker
    args:
      - run
      - --rm
      - -i
      - -e
      - AGENTMEMORY_URL=http://host.containers.internal:$RestPort
      - -v
      - ${SecretsVolume}:/run/secrets:ro
      - agentmemory-mcp-shim
    description: "Agent persistent memory — save, recall, search, sessions"
    enabled: true

"@ -ForegroundColor Yellow

Write-Host @"
NOTE: The secret lives only in the '$SecretsVolume' volume.
      Both the server and shim mount it — no secret in config files or env vars.
      To rotate: podman volume rm $SecretsVolume && re-run this script.
"@ -ForegroundColor Gray

Write-Host "`n=== To verify ===" -ForegroundColor Cyan
Write-Host "  curl http://localhost:${RestPort}/agentmemory/health"
Write-Host "  podman logs $ContainerName"
Write-Host ""
