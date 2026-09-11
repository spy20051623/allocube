param([string]$OutputDirectory = "$PSScriptRoot/../terminal/dist")
$ErrorActionPreference = 'Stop'
$terminalRoot = [IO.Path]::GetFullPath("$PSScriptRoot/../terminal")
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
Push-Location $terminalRoot
try {
  $env:GOOS = 'linux'
  $env:CGO_ENABLED = '0'
  foreach ($architecture in @('amd64', 'arm64')) {
    $env:GOARCH = $architecture
    & go build -trimpath -ldflags='-s -w' -o "$outputRoot/allocube-terminal-linux-$architecture" .
    if ($LASTEXITCODE -ne 0) { throw "Terminal build failed for $architecture" }
  }
  Get-ChildItem -LiteralPath $outputRoot -File | Where-Object Name -Like 'allocube-terminal-linux-*' | Get-FileHash -Algorithm SHA256
} finally {
  $env:GOOS = $previousOS
  $env:GOARCH = $previousArch
  $env:CGO_ENABLED = $previousCGO
  Pop-Location
}
& node "$PSScriptRoot/package-terminal.mjs" $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'Terminal deployment packaging failed' }
