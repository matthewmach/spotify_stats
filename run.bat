@echo off
REM One-click launcher: build data if possible, then serve over http://localhost
REM (so storage works and you never open it as a file://).
cd /d "%~dp0"
if not exist "data\data.json" (
  echo Building data from your Spotify history...
  python build.py
  if errorlevel 1 (
    echo.
    echo No local data built - you can load your JSON files in the browser instead.
    echo.
  )
)
python serve.py
