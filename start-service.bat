@echo off
echo Navigating to project directory...

REM Променя текущата директория към тази, в която се намира .bat файлът
cd /D "%~dp0"

echo Starting Node.js service (CloudFlireServices)...

REM Стартиране на приложението чрез npm start (използва скрипта от package.json)
npm start

echo.
echo The service should be running. If the window closes immediately, there might be an error.
pause