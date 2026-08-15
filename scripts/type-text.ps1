param([Parameter(Mandatory=$true)][string]$text)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Novel Studio")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output "window not found"; exit 1 }
$ct = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$target = $null
for ($i = 0; $i -lt 10 -and -not $target; $i++) {
  $edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ct)
  foreach ($e in $edits) {
    if ($e.Current.Name -and $e.Current.Name.Contains("回复策划")) { $target = $e }
  }
  if (-not $target) { Start-Sleep -Milliseconds 500 }
}
if (-not $target) { Write-Output "edit not found"; exit 1 }
$vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue($text)
Write-Output "typed"
