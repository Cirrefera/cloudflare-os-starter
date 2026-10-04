[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$SecretsDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$originalDirectory = Get-Location
$savedApiToken = $env:CLOUDFLARE_API_TOKEN
$savedApiKey = $env:CLOUDFLARE_API_KEY
$savedApiEmail = $env:CLOUDFLARE_EMAIL

function Invoke-Pnpm {
    param([string[]]$Arguments)
    & npx.cmd --yes --package=pnpm@11.17.0 pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

function Set-PrivateAcl {
    param([string]$Path)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Read-PrivateValue {
    param([string]$Prompt)
    $value = Read-Host $Prompt -AsSecureString
    if ($value.Length -eq 0) { throw "$Prompt cannot be empty." }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Write-SecretSource {
    param([string]$Worker, [hashtable]$Values)
    $path = Join-Path $repoRoot ".secrets\$Worker.json"
    [IO.File]::WriteAllText($path, ($Values | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

try {
    Set-Location $repoRoot
    foreach ($command in @('node', 'npx.cmd', 'git')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Install Node.js 24.19 or newer and Git for Windows, then rerun this script. Missing: $command."
        }
    }
    $nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
    if ($nodeVersion -lt [version]'24.19.0') { throw 'Node.js 24.19 or newer is required.' }

    $secretsRoot = Join-Path $repoRoot '.secrets'
    New-Item -ItemType Directory -Path $secretsRoot -Force | Out-Null
    Set-PrivateAcl $secretsRoot
    if ($SecretsDirectory) {
        foreach ($worker in @('snowflake', 'cloudflareaccount')) {
            $name = "hellgate-os-gatekeeper-$worker.json"
            $source = Join-Path $SecretsDirectory $name
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                $destination = Join-Path $secretsRoot $name
                if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
                    Copy-Item -LiteralPath $source -Destination $destination -Force
                }
            }
        }
    }

    $snowflakePath = Join-Path $secretsRoot 'hellgate-os-gatekeeper-snowflake.json'
    if (-not (Test-Path -LiteralPath $snowflakePath)) {
        Write-Host 'Enter the application credentials returned by Snowflake setup.'
        Write-SecretSource 'hellgate-os-gatekeeper-snowflake' @{
            SNOWFLAKE_ACCOUNT = 'MMVDVTK-DW81715'
            SNOWFLAKE_ROLE = 'CLOUDFLARE_OS_ROLE'
            CLIENT_ID = Read-PrivateValue 'Snowflake OAuth CLIENT_ID'
            CLIENT_SECRET = Read-PrivateValue 'Snowflake OAuth CLIENT_SECRET'
        }
    }
    $accountPath = Join-Path $secretsRoot 'hellgate-os-gatekeeper-cloudflareaccount.json'
    if (-not (Test-Path -LiteralPath $accountPath)) {
        Write-Host 'The supplied Cloudflare Account gatekeeper uses an API token for its native account operations.'
        Write-SecretSource 'hellgate-os-gatekeeper-cloudflareaccount' @{
            CLOUDFLARE_API_TOKEN = Read-PrivateValue 'Cloudflare Account gatekeeper API token'
        }
    }
    # Browser OAuth needs no Hugging Face personal token. AlphaXiv is public.
    Write-SecretSource 'hellgate-os-gatekeeper-huggingface' @{}
    Write-SecretSource 'hellgate-os-gatekeeper-alphaxiv' @{}

    Invoke-Pnpm -Arguments @('install', '--frozen-lockfile')
    Invoke-Pnpm -Arguments @('--dir', 'cloudflare-os', 'install', '--frozen-lockfile')
    Invoke-Pnpm -Arguments @('check:boundary')

    if (-not $CheckOnly) {
        # Force Wrangler to use browser OAuth for deployment, even if a shell token was set.
        Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:CLOUDFLARE_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:CLOUDFLARE_EMAIL -ErrorAction SilentlyContinue
        Invoke-Pnpm -Arguments @('exec', 'wrangler', 'login')
        Invoke-Pnpm -Arguments @('exec', 'wrangler', 'whoami')
    }

    # Runs the existing upstream test suite, the complete build, and Worker dry runs.
    Invoke-Pnpm -Arguments @('check', '--', '--with-secrets')
    if ($CheckOnly) {
        Write-Host 'Checks passed. Nothing was deployed.'
        return
    }

    # Checks just passed; install the isolated Worker secrets and publish the configured graph.
    Invoke-Pnpm -Arguments @('deploy', '--', '--with-secrets', '--skip-tests')

    $metadataUrl = 'https://hellgate-os-router.mchayes89.workers.dev/gatekeeper/huggingface/.well-known/oauth-cimd'
    $metadata = Invoke-RestMethod -Uri $metadataUrl -Method Get -TimeoutSec 30
    if ($metadata.client_id -ne $metadataUrl -or $metadata.token_endpoint_auth_method -ne 'none') {
        throw 'Workers were deployed, but Hugging Face public OAuth metadata could not be verified. Check Cloudflare Access rules for this path.'
    }
    Write-Host 'Deployment complete. Open the OS and connect Snowflake and Hugging Face.'
    Start-Process 'https://hellgate-os-router.mchayes89.workers.dev'
} finally {
    $env:CLOUDFLARE_API_TOKEN = $savedApiToken
    $env:CLOUDFLARE_API_KEY = $savedApiKey
    $env:CLOUDFLARE_EMAIL = $savedApiEmail
    Set-Location $originalDirectory
}
