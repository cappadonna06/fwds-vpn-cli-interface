# Windows Install & Run — FWDS Controller Console

Internal guide for deploying the app on a Windows Surface Pro for local serial use.

## Prerequisites

1. **Rust toolchain** (on the build machine, not the Surface):
   ```
   rustup target add x86_64-pc-windows-msvc
   ```
2. **Node.js 20+** and npm — for the frontend build.
3. **MSVC build tools** — install via "Build Tools for Visual Studio" (C++ workload).
4. No additional serial drivers required for standard USB-CDC adapters (built-in Windows driver).
   FTDI or PL2303 adapters may need the OEM driver from the manufacturer.

## Build Windows Installer

Run on a Windows machine (or a Windows CI runner):

```bash
npm install
npm run tauri build -- --target x86_64-pc-windows-msvc
```

Artifacts are placed in:
```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
  nsis/FWDS Controller Console_0.1.0_x64-setup.exe   ← recommended
  msi/FWDS Controller Console_0.1.0_x64_en-US.msi
```

Copy the `.exe` installer to the shared drive for distribution.

## Install on Surface Pro

1. Run the `.exe` installer — no admin required for current-user install (NSIS default).
2. Launch "FWDS Controller Console" from the Start menu or desktop shortcut.

## Using Local Serial on Windows

1. Plug the USB-serial adapter into the Surface Pro.
2. In the app, click the **Local** tab in the Connect screen.
3. Click **Scan** — the app lists available COM ports (e.g. `COM3 (USB Serial Device)`).
4. Select the correct port and click **Connect**.
5. The Console tab opens automatically. Type commands and press **Send** or Enter.
6. **Ctrl+C** in the console sends an interrupt to the device.
7. Click **Disconnect** when done.

## What Is Not Supported on Windows

- VPN (OpenVPN) connections — macOS only.
- SSH controller connections over VPN — macOS only.
- Diagnostics log file tailing — only available when connected via macOS serial/VPN path.

For VPN workflows, use a macOS machine.
