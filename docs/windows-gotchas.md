# Windows gotchas

Everything in this file was hit for real while building the Windows launcher, and
each item cost time. They are recorded because none of them produce a clear error
message.

---

## 1. `.bat` and `.vbs` files must be pure ASCII

`cmd.exe` and the VBScript engine read script files using the **console codepage**
(936 / GBK on a Chinese Windows), not UTF-8. Consequences:

* Non-ASCII characters in comments can **break parsing**. Symptoms seen:
  * `'xxx' is not recognized as an internal or external command`
  * VBScript: `未结束的字符串常量` ("unterminated string constant") → and because the
    launcher is called with output suppressed, the process **silently fails to start**.
* Full-width box-drawing characters (`┌─┐`) are the worst offenders.

**Rule: keep every `.bat` and `.vbs` ASCII-only.** Put localised text in a `.md`
file, or emit it from Node.

Verify:

```powershell
Get-ChildItem *.bat,*.vbs | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  "{0,-30} non-ASCII: {1}" -f $_.Name, (($b | Where-Object { $_ -gt 127 }).Count)
}
```

## 2. `if (...)` blocks with `&` break

```bat
rem BROKEN - the parenthesised block and the & get mis-parsed
if /i "%~1"=="--port" ( set "ARGS=%ARGS% --port %~2" & shift )
```

Use labels instead:

```bat
if /i "%~1"=="--port" goto arg_port
...
:arg_port
set "ARGS=%ARGS% --port %~2"
shift
shift
goto parse
```

## 3. `for /f "usebackq"` does not want quotes around the command

```bat
rem BROKEN
for /f "usebackq delims=" %%L in (`"C:\path\node.exe" "script.mjs"`) do ...
```

The quotes get mangled. Drop them when the paths contain no spaces, and check the
result is non-empty:

```bat
for /f "usebackq delims=" %%L in (`%NODE% "%HERE%\lan-info.mjs"`) do ...
if not defined PORT ( echo [ERROR] ... & exit /b 2 )
```

Deferring empty-value checks is not optional — see item 6.

## 4. `start /min` kills long-running children

A process started with `start /min` from a `.bat` can die together with the
parent `cmd` window. For a background daemon, launch it through Windows Script
Host instead:

```vbscript
Set shell = CreateObject("WScript.Shell")
pid = shell.Run(cmd, 0, False)   ' 0 = hidden, False = do not wait
```

## 5. WSH gives the child a fresh environment

`WScript.Shell.Run` does **not** forward the parent's environment variables
reliably, and setting them in the `.bat` is not enough. Copy them explicitly:

```vbscript
Set src = CreateObject("WScript.Shell").Environment("PROCESS")
Set env = CreateObject("WScript.Shell").Environment("PROCESS")
env("BIND") = "0.0.0.0"
If Len(Trim("" & src("MY_TOKEN"))) > 0 Then env("MY_TOKEN") = src("MY_TOKEN")
```

Simplest alternative: pass values as **command-line arguments**, or have the child
read them from a file.

## 6. `> file echo %EMPTY%` writes cmd's own banner

If the variable is empty, `echo` prints its status message and that text lands in
the file. Surfaces as a mystery file containing `ECHO is off.` — or, on a Chinese
system, `ECHO 处于关闭状态`. Check the variable first:

```bat
if not defined TOKEN (
  echo [ERROR] no token
  exit /b 2
)
> "file" echo %TOKEN%
```

## 7. `tasklist /FI "PID eq 0"` matches the Idle Process

A PID extracted from the wrong `netstat` column can be `0`, which matches
`System Idle Process` and makes a "is it running?" check always true. Use CIM
instead, and filter out non-positive ids:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*proxy.mjs*' } |
  Select-Object -ExpandProperty ProcessId
```

## 8. `timeout` fails without a console

Under a non-interactive shell, `timeout` prints
`ERROR: Input redirection is not supported`. Use:

```bat
ping -n 2 127.0.0.1 >nul 2>nul
```

## 9. PowerShell inline commands inside `for /f` are fragile

Quotes, pipes, parentheses and semicolons all get re-parsed by `cmd` first. This
produced a literal `PositionalParameterNotFound,…` string where an IP address was
expected. Prefer a small Node/PowerShell **script file** over a one-liner, and
have it print one value per line:

```bat
for /f "usebackq delims=" %%L in (`%NODE% "%HERE%\lan-info.mjs"`) do (
  set /a LINENO+=1
  if !LINENO! EQU 1 set "PORT=%%L"
)
```

(`set /a` plus `!VAR!` needs `EnableDelayedExpansion`.)

## 10. A restricted environment may deny child-process writes

Some sandboxes (and some endpoint-protection products) allow the interactive
shell to write files but return `EPERM` for a script's own writes — including
SQLite, which then reports the database as read-only. If a script must create a
file and fails with `EPERM` on every path, that is the cause. Write the file from
the shell, or have the script print the content and let the shell persist it.

## 11. Firewall rules are per-port, and they see the NATed address

* A rule is created for a specific local port, so changing the port silently
  stops working until a matching rule exists. Create rules as Administrator.
* When traffic arrives through a router, the firewall sees the **router's**
  address, not the real client's. An IP allowlist at the firewall is therefore
  much weaker than one inside the proxy, where `x-forwarded-for` is visible.
* On one machine, an inbound IPv6 connection from a public address was treated as
  `LocalSubnet` because it shared the host's prefix. Do not treat a
  `RemoteIP=LocalSubnet` rule as a security boundary.
