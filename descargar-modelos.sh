#!/bin/bash
# Memoria CRM · descarga los modelos pre-entrenados a la carpeta "modelos" (una vez, con internet).
set -e
cd "$(dirname "$0")"
MODELS="Xenova/paraphrase-multilingual-MiniLM-L12-v2 Xenova/bert-base-multilingual-cased-ner-hrl"
FILES="config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx"
for m in $MODELS; do
  echo; echo "Modelo $m"
  for f in $FILES; do
    dest="modelos/$m/$f"
    mkdir -p "$(dirname "$dest")"
    if [ -s "$dest" ]; then echo "  ya existe  $f"; continue; fi
    echo "  descargando $f ..."
    curl -fL --retry 3 -o "$dest.part" "https://huggingface.co/$m/resolve/main/$f"
    mv "$dest.part" "$dest"
  done
done
echo; echo "Listo. Abre la app con 'Iniciar Memoria CRM'."
