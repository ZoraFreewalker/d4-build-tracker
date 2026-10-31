# OCR an image with the built-in Windows.Media.Ocr engine; prints JSON lines with their position.
# Usage: powershell -NoProfile -File ocr.ps1 <image-path>
#        powershell -NoProfile -File ocr.ps1 -Server   (reads one image path per stdin line, writes one JSON line each)
param([string]$Path, [switch]$Server)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))

function Read-Image([string]$imagePath) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $imagePath).Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose(); if ($bitmap) { $bitmap.Dispose() } } # the bitmap holds native memory
  $lines = foreach ($line in $result.Lines) {
    $words = @($line.Words)
    $first = $words[0].BoundingRect
    $last = $words[-1].BoundingRect
    [pscustomobject]@{ text = $line.Text; x = [int]$first.X; y = [int]$first.Y; w = [int]($last.X + $last.Width - $first.X); h = [int]$first.Height }
  }
  ConvertTo-Json -InputObject @($lines) -Compress
}

if (-not $Server) { Read-Image $Path; exit }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($null -ne ($p = [Console]::In.ReadLine())) {
  try { $out = Read-Image $p } catch { $out = '{"error":' + (ConvertTo-Json -InputObject "$_" -Compress) + '}' }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
