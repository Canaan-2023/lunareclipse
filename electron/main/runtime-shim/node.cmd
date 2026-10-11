@ECHO OFF
REM ============================================================
REM LunarEclipse packaged-mode Node shim (since 0.45)
REM ------------------------------------------------------------
REM WHY THIS FILE EXISTS:
REM   Before 0.45 the installer shipped a standalone portable node.exe
REM   (88.26 MB raw / 20.28 MB compressed). But the Electron main binary
REM   already embeds a Node of the same major line: with
REM   ELECTRON_RUN_AS_NODE=1 it runs in pure-Node mode. The second copy was
REM   pure redundancy, costing about 20 MB of the compressed package.
REM   This shim keeps the bare command `node` working without shipping it.
REM WHAT IT DOES:
REM   Sets ELECTRON_RUN_AS_NODE=1 and forwards every argument to
REM   LunarEclipse.exe in the install root. Exit code and
REM   stdin/stdout/stderr are inherited from the child - the hook exit-code
REM   contract (0=continue / 1=error / 2=block) depends on that.
REM WHY IT MUST NOT BE DELETED:
REM   ensureNodeOnPath() puts this directory on PATH at startup so that a
REM   bare `node` resolves inside user Hooks and MCP stdio servers. Remove
REM   it and we are back to "node is not recognized on machines without a
REM   global Node install" - hooks then fail 5 times in a row and get
REM   silently auto-disabled.
REM Full rationale (Chinese): electron/main/utils/node-runtime.ts
REM
REM ENCODING NOTE - KEEP THIS FILE ASCII-ONLY:
REM   cmd.exe parses batch files in the OEM code page, so non-ASCII comments
REM   break under a code page mismatch. Verified: UTF-8 Chinese REM lines
REM   were executed as commands and the shim exited 255.
REM ============================================================
REM SETLOCAL keeps ELECTRON_RUN_AS_NODE scoped to this batch file and stops
REM it leaking back to the caller. Hard constraint: if the main process
REM inherited it, the multi-instance self-launch in instance.ts
REM spawn(process.execPath) would come up as Node instead of the GUI.
SETLOCAL
SET "ELECTRON_RUN_AS_NODE=1"
REM %~dp0 looks like <install>\resources\tools\ , so two levels up is the
REM directory that holds LunarEclipse.exe.
"%~dp0..\..\LunarEclipse.exe" %*
EXIT /B %ERRORLEVEL%
