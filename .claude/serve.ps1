$root = "C:\Development\jcink-formatter"
$port = 3000
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"

$mime = @{
  ".html" = "text/html"; ".js" = "application/javascript"
  ".css"  = "text/css";  ".json" = "application/json"
  ".mjs"  = "application/javascript"
}

while ($listener.IsListening) {
  $ctx  = $listener.GetContext()
  $req  = $ctx.Request
  $resp = $ctx.Response
  $path = $req.Url.LocalPath -replace "/", "\"
  if ($path -eq "\") { $path = "\index.html" }
  $file = Join-Path $root $path.TrimStart("\")
  if (Test-Path $file) {
    $ext  = [System.IO.Path]::GetExtension($file)
    $resp.ContentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $resp.ContentLength64 = $bytes.Length
    $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $resp.StatusCode = 404
  }
  $resp.OutputStream.Close()
}
