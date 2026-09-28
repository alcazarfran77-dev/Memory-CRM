# Memoria CRM · descarga los modelos pre-entrenados a la carpeta "modelos".
# Solo hace falta una vez y con internet. Después la app funciona sin conexión
# y puedes copiar la carpeta completa (con los modelos) a otros equipos o a un USB.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$models = @('Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'Xenova/bert-base-multilingual-cased-ner-hrl')
$files = @('config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx')
foreach ($m in $models) {
  Write-Host ""
  Write-Host "Modelo $m"
  foreach ($f in $files) {
    $dest = Join-Path $root ("modelos/" + $m + "/" + $f)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { Write-Host "  ya existe  $f"; continue }
    Write-Host "  descargando $f ..."
    Invoke-WebRequest -UseBasicParsing -Uri ("https://huggingface.co/" + $m + "/resolve/main/" + $f) -OutFile ($dest + ".part")
    Move-Item -Force ($dest + ".part") $dest
  }
}
Write-Host ""
Write-Host "Listo. Abre la app con 'Iniciar Memoria CRM'."
