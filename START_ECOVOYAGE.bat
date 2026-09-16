@echo off
title EcoVoyage AI

echo ==========================================
echo        STARTING ECOVOYAGE AI
echo ==========================================
echo.

echo [1/3] Starting MongoDB...
wsl -d Ubuntu -- sudo systemctl start mongod

echo.
echo [2/3] Starting backend...
start "EcoVoyage Backend" cmd /k "cd /d C:\Users\hp\Documents\Codex\2026-08-27\heyy\work\EcoVoyage-AI-repo && npm run serve"

timeout /t 5 /nobreak >nul

echo.
echo [3/3] Starting frontend...
start "EcoVoyage Frontend" cmd /k "cd /d C:\Users\hp\Documents\Codex\2026-08-27\heyy\work\EcoVoyage-AI-repo && npm run dev"

timeout /t 5 /nobreak >nul

echo.
echo Opening EcoVoyage AI...
start http://localhost:5173/

echo.
echo ==========================================
echo       ECOVOYAGE AI IS STARTING!
echo ==========================================