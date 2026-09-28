@echo off
title Memoria CRM - modelos
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0descargar-modelos.ps1"
pause
