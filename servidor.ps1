# Memoria CRM · servidor local para Windows (sin instalar nada).
# Sirve esta carpeta en http://localhost:8765 para que el navegador pueda
# cargar los modelos de IA. Solo escucha en este equipo.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $root.EndsWith('\')) { $root = $root + '\' }

$listener = $null
$port = 8765
for ($p = 8765; $p -lt 8785; $p++) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host 'No hay puertos libres entre 8765 y 8784.'; exit 1 }

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
  '.wasm' = 'application/wasm'; '.onnx' = 'application/octet-stream'; '.svg' = 'image/svg+xml'; '.woff2' = 'font/woff2'
  '.png' = 'image/png'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
}

$url = "http://localhost:$port/index.html"
Write-Host ''
Write-Host "  Memoria CRM abierta en $url"
Write-Host '  Deja esta ventana abierta mientras la usas. Ciérrala para apagar la app.'
Write-Host ''
Start-Process $url

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/')).Replace('/', '\')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $rel))
    if (-not $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($path)) {
      $res.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('No encontrado')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $fs = [System.IO.File]::OpenRead($path)
      try {
        $res.ContentLength64 = $fs.Length
        if ($req.HttpMethod -ne 'HEAD') { $fs.CopyTo($res.OutputStream) }
      } finally { $fs.Dispose() }
    }
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.OutputStream.Close() } catch { }
  }
}
