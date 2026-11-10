@echo off
REM Builds UniqueAcademyAgent.exe into device-service\dist\
cd /d "%~dp0"
python -m pip install -r requirements.txt
python -m PyInstaller --onefile --clean --name UniqueAcademyAgent agent.py
if not exist dist\agent.env copy agent.env.example dist\agent.env
echo.
echo Done. Copy dist\UniqueAcademyAgent.exe and dist\agent.env to the academy PC.
echo Fill in agent.env before running.
pause
