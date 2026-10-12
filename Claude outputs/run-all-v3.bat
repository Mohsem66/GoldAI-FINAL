@echo off
REM Claude - read-only backtest, 4 timeframes, fastest first. Changes no project file.
cd /d C:\GoldAI-FINAL\backend
set LOG="C:\GoldAI-FINAL\Claude outputs\run-all-log-v3.txt"
echo START %date% %time% > %LOG%
echo === H4 365 days === >> %LOG%
node "..\Claude outputs\claude-backtest-v3.js" 365 H4 >> %LOG% 2>&1
echo === H1 365 days === >> %LOG%
node "..\Claude outputs\claude-backtest-v3.js" 365 H1 >> %LOG% 2>&1
echo === M15 180 days === >> %LOG%
node "..\Claude outputs\claude-backtest-v3.js" 180 M15 >> %LOG% 2>&1
echo === M5 180 days === >> %LOG%
node "..\Claude outputs\claude-backtest-v3.js" 180 M5 >> %LOG% 2>&1
echo ALL FINISHED %date% %time% >> %LOG%
echo ALL FINISHED - you can close this window.
