param(
    [ValidateSet('all', 'api', 'web', 'lp', 'trade')]
    [string]$Service = 'all'
)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$webPath = Join-Path $repoPath 'web'
$services = @{
    api = @{ Title = '4lpha - API'; Directory = $repoPath; Arguments = @('run', 'dev-plane') }
    web = @{ Title = '4lpha - Web'; Directory = $webPath; Arguments = @('run', 'dev', '--', '--port', '3000') }
    lp = @{ Title = '4lpha - LP / Grid worker'; Directory = $repoPath; Arguments = @('run', 'lp-worker') }
    trade = @{ Title = '4lpha - Trading worker'; Directory = $repoPath; Arguments = @('run', 'trade-worker') }
}

try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Install Node.js 22 or newer, then reopen this launcher.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'node_modules/tsx/package.json'))) {
        throw 'Missing API dependencies. Run npm ci in the repo folder first.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $webPath 'node_modules/next/package.json'))) {
        throw 'Missing web dependencies. Run npm ci in the web folder first.'
    }

    if ($Service -eq 'all') {
        Write-Host 'Opening API, web, LP/Grid and Trading worker consoles.'
        Write-Host 'Workers run LIVE when enabled in your existing configuration.'
        Write-Host 'Stop any manually started workers first. Use Ctrl+C in each console to stop.'
        foreach ($serviceName in @('api', 'web', 'lp', 'trade')) {
            $shellArguments = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "{0}" -Service {1}' -f $PSCommandPath, $serviceName
            Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $shellArguments -WorkingDirectory $repoPath -WindowStyle Normal | Out-Null
        }
        Write-Host 'App: http://localhost:3000 (wait for Ready in the Web console).'
        return
    }

    $entry = $services[$Service]
    $Host.UI.RawUI.WindowTitle = $entry.Title
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try {
        $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($repoPath.ToLowerInvariant())
        $checkoutId = [System.BitConverter]::ToString($hash.ComputeHash($pathBytes)).Replace('-', '')
    } finally {
        $hash.Dispose()
    }
    # Keep ownership in this console until the foreground npm command returns.
    $mutex = New-Object System.Threading.Mutex($false, "Local\4lpha-dev-$checkoutId-$Service")
    $ownsMutex = $false
    try {
        try { $ownsMutex = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) {
            Write-Host 'Already running through this launcher. Use the existing console.'
            return
        }
        Set-Location -LiteralPath $entry.Directory
        Write-Host $entry.Title
        if ($Service -in @('lp', 'trade')) {
            Write-Host 'LIVE worker: existing feature flags and session permissions apply.'
            Write-Host 'Do not run another copy manually or from another checkout.'
        }
        Write-Host 'Press Ctrl+C to stop. Errors remain visible in this console.'
        $npmArguments = $entry.Arguments
        & $npmPath @npmArguments
        $serviceExitCode = $LASTEXITCODE
        Write-Host "Service stopped (exit code $serviceExitCode)."
        if ($serviceExitCode -ne 0) { throw 'Service failed. See its output above.' }
    } finally {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    # An explicit exit would close a -NoExit child and hide its error output.
    if ($Service -eq 'all') { exit 1 }
}
