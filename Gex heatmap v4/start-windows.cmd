@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto run
echo Python environment is missing. See README.txt for setup.
pause
exit /b 1
:run
".venv\Scripts\python.exe" opend_board.py --open-browser --origin https://opend-gex-board.super-fir-5013.chatgpt.site
pause
