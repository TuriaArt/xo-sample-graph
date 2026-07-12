@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск XO Sample Graph v3.0.0 ...
npm start
echo.
echo Приложение закрыто.
pause
