# List QA headless chrome processes started by this QA session (matched by the
# user-data-dir marker this session's scripts use). Read-only listing.
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
foreach ($p in $procs) {
  if ($p.CommandLine -match 'iris-qa-cdp|iris-probe') {
    $head = $p.CommandLine
    if ($head.Length -gt 150) { $head = $head.Substring(0, 150) }
    Write-Output ("PID=" + $p.ProcessId + " PPID=" + $p.ParentProcessId + " CMD=" + $head)
  }
}
