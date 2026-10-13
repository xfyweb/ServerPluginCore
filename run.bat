@echo off
REM Start the core daemon (cmd.exe entry point).
REM
REM ASCII ONLY, on purpose: cmd.exe reads .bat files in the OEM code page, so non-ASCII
REM comments get decoded into garbage and then EXECUTED as commands (seen in practice).
REM The Chinese explanation lives in README.md and in the other entry points.
REM
REM Foreground Ctrl+C: cmd.exe will ask "Terminate batch job (Y/N)?" -- that is cmd reacting
REM to a batch job, not the daemon. Use run.ps1 (no cmd in the chain) or `node server.js`
REM for a clean foreground experience.
REM
REM Long running: `pm2 start` (uses ecosystem.config.js in this folder) or a service manager.
REM Same environment variables as running the daemon directly:
REM   SPC_PORT / SPC_STATE_DIR / SPC_AUDIT_DIR / SPC_SHUTDOWN_TIMEOUT_MS
node "%~dp0server.js" %*
REM pause keeps a double-clicked window open after the daemon exits (maintainer's addition).
pause
exit /b %ERRORLEVEL%
