# Platform notes

Platform-specific behavior for the two supported operating systems. See
[`architecture.md`](architecture.md) for the overall design.

## macOS — OpenVPN elevation

On macOS the app can start OpenVPN from inside the UI, but only through an
**elevated launch path**. A normal app process can run the `openvpn` binary, but
it cannot create the `utun` tunnel device without administrator privileges. The
symptom without elevation: OpenVPN launches, the TLS handshake succeeds, tunnel
creation fails with `Operation not permitted`, and the session exits before
`Initialization Sequence Completed`.

### How the elevated launch works

1. The operator selects a local VPN bundle folder.
2. The backend validates the bundle.
3. The bundle is staged into a temp directory under `/private/tmp`.
4. A launcher script is written into that staged directory.
5. The app requests administrator privileges from macOS.
6. The launcher starts OpenVPN using the staged config and staged working
   directory.
7. OpenVPN logs are written to a temp log file and streamed back into the app.
8. The VPN is treated as connected on `Initialization Sequence Completed`.

### Why the design is shaped this way

- **Staging avoids protected-folder access.** Bundles often live in
  `~/Downloads`, which was unreliable to read from in the elevated path. Staging
  into `/private/tmp` removes that dependency.
- **Relative paths in `ovpn.conf` matter.** The config references `ca ovpn.crt`,
  `cert ovpn-fwds-client.crt`, and `key ovpn-fwds-client.key` relatively, so the
  launch working directory must match what OpenVPN expects — hence the staged
  working directory.
- **Root-owned process tracking.** Once started with elevation, the process is
  root-owned; liveness must not be inferred from a normal-user check. Staged
  files are not cleaned up while the process is alive.
- **Stale sessions are stopped** before a new one starts.

### Operator experience

Select the bundle folder → `Start VPN` → approve the macOS admin prompt → wait
for connect → continue into controller connectivity. No second terminal window
is needed to bring up the VPN.

### Known limitations

- This is an elevation path, not a packaged privileged-helper architecture.
- Elevated VPN startup behavior is macOS-specific.
- OpenVPN warnings can still be noisy. The clean long-term direction is a true
  privileged helper/daemon for VPN lifecycle management.

## Windows — VPN, local SSH, and local serial

Windows supports the VPN/OpenVPN path, local-network SSH, and local serial
(USB/COM). SSH and serial both open in a real PuTTY terminal. The app sends
commands to that PuTTY window and parses PuTTY's session log to populate the
diagnostic cards.

### Connect over VPN or the local network

1. Load the VPN bundle once so the console can install the `station` SSH key.
2. For VPN access, start the VPN and then connect to the controller. For local
   access, choose **Local** mode, choose **Network (SSH)**, and enter or find
   the controller address.
3. The app silently converts the bundle's `station` key to PuTTY's PPK format,
   then opens PuTTY as `root`. PuTTYgen is not invoked.
4. Run commands and diagnostic blocks from the console; their output populates
   the diagnostic cards directly.

### Connect on a Windows device

1. Open the app and go to the **Connect** tab.
2. Choose **Local** mode.
3. Click **Refresh** to list COM ports.
4. Select the COM device (a friendly label is shown in the picker).
5. Click **Connect**.
6. The app opens PuTTY on that COM port at `115200 8N1`.
7. Use the PuTTY window directly for login, password prompts, and interactive
   commands.

### Building the Windows installer

1. Install the Rust + Node.js toolchain and Tauri prerequisites for Windows.
2. From the repo root: `npm install`, then `npm run tauri build`.
3. Installer artifacts are produced under `src-tauri/target/release/bundle/`.

### Troubleshooting

- **Port busy** — another app is using the COM port; close it and reconnect.
- **Access denied** — reconnect the device or run with the required permissions.
- **Device disconnected** — re-seat the USB cable and reconnect.
- **PuTTY not found** — install PuTTY, or ensure `putty.exe` is on a standard
  install path.
