# 使用本機 Microsoft Word 將 output/word/*.docx 轉成 output/pdf/*.pdf，並回報頁數
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wordDir = Join-Path $root "output\word"
$pdfDir = Join-Path $root "output\pdf"
New-Item -ItemType Directory -Force $pdfDir | Out-Null

$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    Get-ChildItem $wordDir -Filter *.docx | ForEach-Object {
        $doc = $word.Documents.Open($_.FullName, $false, $true)
        $pages = $doc.ComputeStatistics(2)   # wdStatisticPages
        $pdf = [string](Join-Path $pdfDir ($_.BaseName + ".pdf"))
        $doc.ExportAsFixedFormat($pdf, 17)    # wdExportFormatPDF
        $doc.Close(0)
        Write-Output ("{0} -> {1} pages" -f $_.BaseName, $pages)
    }
}
finally {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
