# Windows local serial (Surface Pro) quick notes

## Scope
- Windows support is local serial (USB/COM) only.
- Windows VPN/OpenVPN flow is not supported in this release.

## Build installer (internal)
1. Install Rust + Node.js toolchain and Tauri prerequisites for Windows.
2. From repo root:
   - `npm install`
   - `npm run tauri build`
3. Share generated installer artifacts from `src-tauri/target/release/bundle/` via internal shared drive.

## Run/connect on Surface Pro
1. Start app and go to **Connect** tab.
2. Choose **Local** mode.
3. Click **Refresh** to list COM ports.
4. Select the COM device (friendly label shown in picker).
5. Click **Connect**.
6. Use app send actions/Enter to send commands to the active local serial session.

## Troubleshooting
- **Port busy**: another app is using the COM port; close it and reconnect.
- **Access denied**: run with required permissions or reconnect device.
- **Device disconnected**: re-seat USB cable and reconnect.
- **Session not open**: connect local serial first.
