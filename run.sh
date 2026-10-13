#!/bin/sh
# Start the core daemon (POSIX entry point).
#
# ASCII ONLY, on purpose: keep every run.* entry point readable by any shell/editor
# (cmd.exe reads .bat in the OEM code page; Windows PowerShell 5.1 assumes ANSI for
# BOM-less .ps1). The Chinese explanation lives in README.md.
#
# Env and args are passed through unchanged:
#   SPC_PORT=18777 SPC_STATE_DIR=/var/lib/spc ./run.sh
#
# `exec` is required: it makes the daemon REPLACE this script, so Ctrl+C / systemd's
# SIGTERM land on it directly -- one less process layer (a parent dying can take its
# child with it; that bit us in bin/_launch.mjs).
#
# Long running: `pm2 start` (ecosystem.config.js) or a systemd unit (template planned, see
# docs/ROADMAP.md -- the P5 hardening step).
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/server.js" "$@"
