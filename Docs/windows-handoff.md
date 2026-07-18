# FWDS Controller Console — Windows session handoff

> Working handoff for a Windows testing/fix session. Captures the state of the
> Windows connection paths as of branch `fix/windows-puttygen-ppk-resolution`.
> This doc is a WIP artifact — safe to remove before merging to `main`.

## Implementation update (July 17, 2026)

The historical investigation below led to a different final implementation:

- Windows SSH opens in a real external PuTTY terminal. The in-app terminal and
  piped `ssh.exe` experiment were removed.
- The app converts the bundle's PKCS#1/OpenSSH RSA `station` key to an
  unencrypted PPK v3 file in-process. It never invokes PuTTYgen, so the
  unsupported `-O` option and its modal popup are gone.
- Command buttons still send to the PuTTY window, and diagnostic cards still
  parse PuTTY's session log.
- Local controllers are discovered with an embedded mDNS browser. Windows no
  longer needs Bonjour/`dns-sd.exe`; a single detected controller's resolved IP
  is filled automatically, with manual address entry retained as a fallback.

The sections below are retained as historical diagnosis and should not be read
as the current implementation state.

## TL;DR

- **Connect works** on both VPN and local SSH — a controller terminal window opens.
- **Blocker:** sending commands / running diagnostic blocks fails with
  *"Failed to send command to PuTTY: PuTTY window not found"* → **diagnostic cards
  never populate.** This is the core purpose of the app, so it's release-blocking
  on Windows.
- **One fix is on this branch** (the puttygen `-O` popup). It compiles for Windows
  (`cargo check --target x86_64-pc-windows-gnu` is clean) but needs on-device
  verification.
- No CI exists (no `.github/workflows`), so Windows is only exercised by hand.

## 0. Setup

```bash
git fetch origin
git checkout fix/windows-puttygen-ppk-resolution
npm install
npm run tauri dev
```

Compile-only sanity (also works from macOS, no Windows box needed):

```bash
rustup target add x86_64-pc-windows-gnu
cd src-tauri && cargo check --target x86_64-pc-windows-gnu   # clean; 7 pre-existing dead-code warnings
```

## 1. Confirmed Windows architecture

All references are `src-tauri/src/lib.rs`. Three connection entrypoints:

| Flow         | Fn                                  | Transport                                   |
| ------------ | ----------------------------------- | ------------------------------------------- |
| Local serial | `open_local_serial_terminal` (2569) | PuTTY `-serial COMx -sercfg 115200,8,n,1,N` |
| Local SSH    | `open_local_network_terminal` (2801)| PuTTY `-ssh` **or** `ssh.exe` fallback      |
| VPN SSH      | `open_controller_terminal` (2310)   | PuTTY `-ssh` **or** `ssh.exe` fallback      |

- The VPN **tunnel** is separate: `launch_openvpn_windows` (4153) runs
  `Start-Process openvpn.exe -Verb RunAs` (elevated PowerShell → UAC). That is the
  only "PowerShell" part; the controller **shell** is PuTTY, same as local.
- **Local SSH and VPN SSH are byte-for-byte identical** in their Windows branch
  (2359 vs 2849) — same `match (find_putty_executable(), ensure_station_ppk())`,
  PuTTY arm or `spawn_windows_ssh_console` fallback. Fix one → fix both. Keep them
  identical.

### The invariant (must hold on any change)

- **Send command / diagnostic block:** `send_external_input` (3074) →
  `send_text_to_putty_window` (997) → `PostMessageW(WM_CHAR)` to a top-level window
  whose class is **exactly `"PuTTY"`** (949).
- **Diagnostic cards:** a log watcher tails the file PuTTY writes via `-sessionlog`;
  the parser reads that file.
- **Both are PuTTY-only.** The `ssh.exe` fallback console has class
  `ConsoleWindowClass` (never matches 949) and writes no session log — so on the
  fallback, **both send and diagnostics are structurally dead**, even though the
  connection itself looks fine.

## 2. Already fixed on this branch: the puttygen "-O" popup

**Symptom:** on Connect, a *"PuTTYgen command line error: unrecognized option '-O'"*
dialog blocked the flow; dismissing it let the terminal open.

**Root cause:** `ensure_station_ppk` (1090) converts the OpenSSH `station` key to
`.ppk` via `puttygen station -O private -o station.ppk`. `puttygen.exe` is a
windowed program with no console, so a CLI error becomes a **modal dialog**, and
Rust's `.output()` blocks until it's dismissed. The conversion was failing because
`find_puttygen_executable` searched **PATH first**, independently from
`find_putty_executable` — so a stray/old `puttygen.exe` on PATH got picked instead
of the one next to the real PuTTY.

**Fix applied** (in `ensure_station_ppk`, ~1108): resolve `puttygen.exe` **next to
the `putty.exe` we actually launch**, fall back to the PATH search only if absent;
added `CREATE_NO_WINDOW`. The `ssh.exe` fallback is still intact.

**Verify on device:** the `-O` popup should be gone, and the session should open via
**PuTTY**, not the OpenSSH fallback. The single most important check — the app log
line at 2386/2874 reads either `[PuTTY opened]` or `[OpenSSH opened]`. That one line
tells you which transport you're on, and everything in §3 branches on it.

## 3. THE BLOCKER: "PuTTY window not found" on send / diagnostics

The error comes from **lib.rs:1010** — `find_putty_window` returned `None`, meaning
**EnumWindows found no top-level window of class `"PuTTY"` at send time.** There is a
*different* error at **1026** (*"Failed to send command to PuTTY."*, no "not found")
that fires when the window IS found but `PostMessageW` is blocked — we are **not**
getting that one, which rules out cross-integrity/UIPI blocking.

### Step 1 — settle the transport (do this first)

Check the `[… opened]` log line, or Task Manager, for **`putty.exe` vs `ssh.exe`**:

- **If `[OpenSSH opened]` / `ssh.exe`:** the puttygen fix didn't take (old build, or
  a genuinely broken puttygen), so you're still on the fallback and "window not
  found" is *expected* — it isn't a PuTTY window. → Confirm the §2 fix is in the
  running build; run `& "C:\Program Files\PuTTY\puttygen.exe" -V` (genuine PuTTY
  ≥0.61 supports `-O`; if it errors, install current PuTTY from putty.org).
- **If `[PuTTY opened]` / `putty.exe`:** the fix worked; this is a real
  window-discovery bug → Step 2.

### Step 2 — if it's genuinely PuTTY, ranked causes

1. **Timing vs the host-key Security Alert (leading suspect).** The PuTTY launch args
   (2363) set **no host-key auto-accept** (unlike the `ssh.exe` path, which sets
   `StrictHostKeyChecking=no`). On first connect PuTTY shows a *"Security Alert"*
   dialog; until it's accepted, the class-`"PuTTY"` terminal window **doesn't exist
   yet** — only the dialog does. `send_text_to_putty_window` retries only **2 seconds**
   (20×100ms, line 1003) then gives up. If diagnostics auto-fire on connect, they hit
   the 2s wall while PuTTY waits on the dialog.
   **Test:** manually accept the host key, wait, then run a diagnostic block — if that
   works, this is it.
   *Fixes:* pre-accept the host key (PuTTY `-hostkey`, or seed the registry key),
   widen the retry window, and/or detect the Security Alert dialog.
2. **Window class isn't exactly `"PuTTY"`.** Genuine PuTTY's terminal class *is*
   `"PuTTY"`, so this is unlikely — but confirm with AutoIt Window Info / Spy++ on the
   open terminal. If it differs, the exact-match at 949 fails.
   *Fix:* match by the spawned PID's window regardless of class, or relax the compare.
3. **PID + class both miss.** `find_putty_window` already falls back to "any
   PuTTY-class window" (968), so if even that fails it's not a PID problem — it's cause
   1 or 2.

### Strategic fix worth weighing

The whole Windows approach — puppeteer a GUI PuTTY window with `WM_CHAR` and scrape
its `-sessionlog` file — is fragile and is the source of every §2/§3 symptom. The
robust design is **`plink.exe`** (PuTTY's CLI tool, ships in the same install) or
`ssh.exe` with **piped stdin/stdout**: send = write stdin, diagnostics = read stdout,
no window to find, no `WM_CHAR`, no session-log file, no host-key dialog
(`plink -batch`). That mirrors what macOS gets from `script`/ssh, and what the now-dead
`connect_controller` fn was reaching for. It would fix send AND diagnostics AND delete
the sessionlog dependency in one move. Bigger change; a maintainer decision.

## 4. Other Windows issue disposition

- **SD Card Maker:** zero-byte reader slots are now hidden on Windows and macOS.
  System/boot disks remain excluded, the UI no longer claims every listed USB
  device is removable, and the erase confirmation shows the selected name and
  size. Windows cannot reliably distinguish every USB SD reader from an external
  USB drive, so the operator must still confirm the target before writing.
- **Session logging:** PuTTY SSH logging remains enabled on Windows because
  connection state and diagnostic cards consume it. Settings now distinguishes
  app-managed transcripts from this required PuTTY log and accurately warns that
  PuTTY cannot redact typed credentials.
- **Local → Network discovery:** fixed with the embedded mDNS browser; Bonjour and
  `dns-sd.exe` are no longer required.
- **Full Disk Access recovery:** the frontend now shows this macOS-only recovery
  panel only on macOS; Windows permission errors retain the ordinary failure UI.

## 5. Docs to fix (currently mislead a technician)

- `Docs/platform-notes.md` and `README.md:35` say Windows is serial-only / "VPN not
  supported" — false; VPN + local SSH are implemented.
- `CHANGELOG.md` promises secrets are redacted before writing, which isn't true on
  Windows (PuTTY owns the log; the Settings tab warns, the changelog doesn't).

## 6. What to capture and send back

1. The `[… opened]` log line (PuTTY vs OpenSSH). ← decides everything
2. `& "C:\Program Files\PuTTY\puttygen.exe" -V` and `& "...\putty.exe" -V`.
3. Whether diagnostics work **after** manually accepting the host key and waiting.
4. The open terminal's window **class** (AutoIt Window Info / Spy++).

## 7. Acceptance criteria

- Local SSH **and** VPN SSH open via **PuTTY** (`[PuTTY opened]`), no `-O` popup.
- Diagnostic blocks send **and** cards populate on **both**.
- If PuTTY/puttygen is missing or unusable: an **explicit, actionable error**, never a
  connected-but-dead session.
- `cargo check --target x86_64-pc-windows-gnu` stays clean; macOS path unchanged.
