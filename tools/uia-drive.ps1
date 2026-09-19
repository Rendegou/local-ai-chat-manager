# 通过 UI Automation 操作真实窗口里的 WebView2 内容（不需要窗口在前台）。
#
# 为什么不用坐标点击：截图里的像素位置要靠显示器缩放反推，算错一次就点到别的控件上
# （实测点 Gemini 行弹出了目录选择框）。按可访问名称定位是精确的，而且顺带验证了
# 界面元素确实有可访问名称。
#
# 用法：
#   pwsh -NoProfile -File tools/uia-drive.ps1 -ProcId 1234 -Log ops.txt
#
# ops.txt 每行一条：
#   invoke <按钮名>            按名称 Invoke 一个按钮
#   set <输入框名> <值>        给一个文本框赋值（ValuePattern）
#   wait <毫秒>                等待
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][string]$Log
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
if ($null -eq $win) { Write-Output 'NO_WINDOW'; exit 1 }

function Find-ByTypeAndName([string]$name, $controlType) {
  $typeCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
  $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $both = New-Object System.Windows.Automation.AndCondition($typeCond, $nameCond)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $both)
}

foreach ($line in Get-Content -LiteralPath $Log -Encoding UTF8) {
  $line = $line.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { continue }
  $parts = $line -split '\s+', 3
  switch ($parts[0]) {
    'invoke' {
      $btn = Find-ByTypeAndName $parts[1] ([System.Windows.Automation.ControlType]::Button)
      if ($null -eq $btn) { Write-Output "NOT_FOUND button $($parts[1])"; continue }
      $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-Output "INVOKED $($parts[1])"
    }
    'set' {
      $box = Find-ByTypeAndName $parts[1] ([System.Windows.Automation.ControlType]::Edit)
      if ($null -eq $box) { Write-Output "NOT_FOUND edit $($parts[1])"; continue }
      $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($parts[2])
      Write-Output "SET $($parts[1])"
    }
    'wait' { Start-Sleep -Milliseconds ([int]$parts[1]) }
    default { Write-Output "SKIP $line" }
  }
  Start-Sleep -Milliseconds 300
}
Write-Output 'DONE'
