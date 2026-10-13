#!/usr/bin/env pwsh
# Start the core daemon (Windows / PowerShell entry point).
#
# ASCII ONLY, on purpose: Windows PowerShell 5.1 treats a BOM-less UTF-8 .ps1 as ANSI, so
# non-ASCII comments/comments could be mis-parsed. (cmd.exe has the same problem with .bat.)
# The Chinese explanation lives in README.md.
#
# This path does NOT go through cmd.exe, so Ctrl+C is handled by the daemon itself:
# it prints its own shutdown lines without the cmd batch-job question.
# Long running: `pm2 start` (ecosystem.config.js) or a service manager.
#
# Same environment variables as running the daemon directly:
#   SPC_PORT / SPC_STATE_DIR / SPC_AUDIT_DIR / SPC_SHUTDOWN_TIMEOUT_MS
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
& node (Join-Path $here 'server.js') @args
exit $LASTEXITCODE
