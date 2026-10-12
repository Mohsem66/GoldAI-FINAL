@echo off
cd /d C:\GoldAI-FINAL\backend
if not exist C:\GoldAI-FINAL\backend\worker\logs mkdir C:\GoldAI-FINAL\backend\worker\logs
"C:\Program Files\nodejs\node.exe" worker\signal-worker.js >> C:\GoldAI-FINAL\backend\worker\logs\worker-out.log 2>> C:\GoldAI-FINAL\backend\worker\logs\worker-err.log
