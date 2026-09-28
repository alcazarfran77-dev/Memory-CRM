#!/bin/bash
# Memoria CRM · lanzador para macOS (doble clic) y Linux.
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Necesitas Python 3. En macOS: xcode-select --install"; read -r -p "Pulsa Enter para cerrar"; exit 1
fi
python3 servidor.py
