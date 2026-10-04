[CmdletBinding()]
param([switch]$CheckOnly, [string]$SecretsDirectory)

$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PSScriptRoot 'cloudflare-os.bundle'
$repo = Join-Path $PSScriptRoot 'cloudflare-os-starter'
foreach ($command in @('git', 'node', 'npx.cmd')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Install Git for Windows and Node.js 24.19 or newer, then rerun. Missing: $command."
    }
}
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
    throw 'Extract the complete download first. cloudflare-os.bundle must be beside this launcher.'
}
if (-not (Test-Path -LiteralPath $repo)) {
    # Upstream ships symbolic links. Check support before attempting a partial clone.
    $probe = Join-Path ([IO.Path]::GetTempPath()) ('cfos-link-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $probe | Out-Null
    try {
        $target = Join-Path $probe 'target.txt'
        [IO.File]::WriteAllText($target, 'link check')
        # Node supports Developer Mode without elevation; Windows PowerShell 5.1's
        # New-Item SymbolicLink still asks for elevation on some Windows versions.
        'import { symlinkSync } from "node:fs"; symlinkSync(process.argv[2], process.argv[3], "file");' |
            & node --input-type=module - $target (Join-Path $probe 'link.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Symbolic links are unavailable.' }
    } catch {
        throw 'Upstream needs symbolic links. Enable Windows Developer Mode, or rerun this launcher in an Administrator PowerShell.'
    } finally {
        Remove-Item -LiteralPath $probe -Recurse -Force
    }
    & git -c core.autocrlf=false -c core.symlinks=true clone --branch main $bundle $repo
    if ($LASTEXITCODE -ne 0) { throw 'Source checkout failed. The bundle remains available; stop here and inspect the Git error.' }
}
# Import the official commit used to verify source bytes; all its tree objects are already
# in the snapshot bundle. This avoids downloading upstream history just to check provenance.
$pinPack = Join-Path $PSScriptRoot 'upstream-pin.pack'
if (-not (Test-Path -LiteralPath $pinPack -PathType Leaf)) { throw 'Extract upstream-pin.pack beside the launcher.' }
$processInfo = [Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = 'git'
$processInfo.Arguments = '-C "' + $repo + '" index-pack --stdin'
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardInput = $true
$process = [Diagnostics.Process]::Start($processInfo)
$stream = [IO.File]::OpenRead($pinPack)
try { $stream.CopyTo($process.StandardInput.BaseStream) }
finally { $stream.Dispose(); $process.StandardInput.Close() }
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw 'Could not import upstream provenance; stop here.' }
$process.Dispose()
$arguments = @{}
if ($CheckOnly) { $arguments.CheckOnly = $true }
if ($SecretsDirectory) { $arguments.SecretsDirectory = $SecretsDirectory }
& (Join-Path $repo 'scripts\deploy-local.ps1') @arguments
