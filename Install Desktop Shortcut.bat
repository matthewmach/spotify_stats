@echo off
REM Creates a "Spotify Stats" shortcut on your Desktop that launches the app the
REM right way (local http server + browser), so you never open it as a file://.
setlocal
set "TARGET=%~dp0run.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Spotify Stats.lnk');" ^
  "$lnk.TargetPath = '%TARGET%';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.IconLocation = '%SystemRoot%\System32\shell32.dll,220';" ^
  "$lnk.Description = 'Open your Spotify Listening Stats';" ^
  "$lnk.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo Created "Spotify Stats" on your Desktop. Double-click it to launch the app.
)
pause
