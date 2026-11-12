param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$taskMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
function Wait-WinRT($Operation,[Type]$ResultType){
 $task=$taskMethod.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
 $task.GetAwaiter().GetResult()
}
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('en-US')))
if($null -eq $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
if($null -eq $engine){throw 'Windows OCR language pack unavailable'}
$file=Wait-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Wait-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try{
 $decoder=Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 $texts=@()
 foreach($angle in @(0,180,90,270)){
  $transform=New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.Rotation=[Windows.Graphics.Imaging.BitmapRotation]($angle/90)
  $ratio=[Math]::Min(1.0,3000.0/[Math]::Max($decoder.PixelWidth,$decoder.PixelHeight))
  $transform.ScaledWidth=[uint32][Math]::Max(1,[Math]::Round($decoder.PixelWidth*$ratio))
  $transform.ScaledHeight=[uint32][Math]::Max(1,[Math]::Round($decoder.PixelHeight*$ratio))
  $bitmap=Wait-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,$transform,[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try{$result=Wait-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]);$texts+=($result.Lines | ForEach-Object {$_.Text}) -join "`n"}finally{$bitmap.Dispose()}
 }
 @{text=($texts -join "`n")} | ConvertTo-Json -Compress
}finally{$stream.Dispose()}
