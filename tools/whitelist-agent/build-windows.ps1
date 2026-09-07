cd $PSScriptRoot
npm install --omit=dev
npx --yes @yao-pkg/pkg index.js --targets node18-win-x64 --output FlowDesk-Whitelist-Agent.exe
if (Test-Path .\FlowDesk-Whitelist-Agent.exe) {
  Write-Host "EXE gerado: FlowDesk-Whitelist-Agent.exe"
} else {
  Write-Host "Nao gerou EXE. Use start.cmd com Node instalado."
}
