use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::State;

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct InnerState {
    // VPN (OpenVPN managed as elevated root process)
    managed_openvpn_pid: Option<u32>,
    managed_openvpn_log_path: Option<String>,
    managed_openvpn_log_offset: u64,
    managed_openvpn_stage_dir: Option<String>,
    vpn_phase: String,    // disconnected | connecting | connected | failed
    vpn_detail: String,
    vpn_logs: Vec<String>,

    // Controller shell (SSH session)
    shell_child: Option<Child>,
    shell_stdin: Option<ChildStdin>,
    shell_phase: String,  // disconnected | connecting | connected | failed
    shell_detail: String,
    controller_ip: Option<String>,
    shell_logs: Vec<String>,
    shell_log_cursor: usize, // how many lines ConsoleTab has already consumed
    // True when the last stdout flush was a wizard prompt waiting for input.
    // Some prompts have an editable pre-filled value; others are simple yes/no
    // choices that should accept raw Enter or a single replacement character.
    shell_wizard_input: bool,
    // True only when the last wizard prompt included editable pre-filled text
    // that must be cleared before inserting the user's replacement.
    shell_wizard_needs_clear: bool,
    // Set by send_input when responding to a wizard prompt so the output
    // processor can suppress the immediate one-shot readline redraw that
    // follows the submission.
    shell_suppress_redraw: bool,
    // When true, each raw normalized chunk from SSH stdout is pushed to shell_logs
    // as a \x03-prefixed debug entry so operators can see exactly what the
    // controller sends and when.
    shell_debug: bool,
}

struct AppState {
    inner: Arc<Mutex<InnerState>>,
}

const REQUIRED_FILES: &[&str] = &[
    "ovpn.conf",
    "ovpn.crt",
    "ovpn-fwds-client.crt",
    "ovpn-fwds-client.key",
    "station",
    "connect.bin",
    "connect-local.bin",
];

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn select_vpn_folder(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    match path {
        Some(p) => Ok(p.to_string()),
        None => Err("No folder selected".into()),
    }
}

#[tauri::command]
async fn validate_bundle(folder: String) -> Result<serde_json::Value, String> {
    let mut results = serde_json::Map::new();
    for file in REQUIRED_FILES {
        let exists = Path::new(&folder).join(file).exists();
        results.insert(file.to_string(), serde_json::Value::Bool(exists));
    }
    Ok(serde_json::Value::Object(results))
}

/// Start OpenVPN. Stages bundle, writes launcher script, elevates via osascript.
/// Auto-kills any existing openvpn sessions first.
#[tauri::command]
fn start_vpn(folder: String, state: State<'_, AppState>) -> Result<(), String> {
    let existing_pids = reset_vpn_state(&state)?;
    let stage_dir = stage_bundle(&folder)?;
    let staged_config = stage_dir.join("ovpn.conf");
    let log_path = vpn_log_path();
    let openvpn_binary = resolve_openvpn()?;
    let launcher = write_launcher_script(&stage_dir, &staged_config, &log_path, &openvpn_binary)?;
    let pid = launch_openvpn_elevated(&launcher, &existing_pids)?;

    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    inner.managed_openvpn_pid = Some(pid);
    inner.managed_openvpn_log_path = Some(log_path.to_string_lossy().into_owned());
    inner.managed_openvpn_log_offset = 0;
    inner.managed_openvpn_stage_dir = Some(stage_dir.to_string_lossy().into_owned());
    inner.vpn_phase = "connecting".into();
    inner.vpn_detail = "OpenVPN starting with administrator privileges".into();
    push_vpn_log(&mut inner, format!("Staged bundle → {}", stage_dir.display()));
    push_vpn_log(&mut inner, format!("OpenVPN PID: {pid}"));
    push_vpn_log(&mut inner, format!("Log file: {}", log_path.display()));
    Ok(())
}

/// Stop the managed OpenVPN process (elevated kill via osascript).
#[tauri::command]
fn stop_vpn(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    let Some(pid) = inner.managed_openvpn_pid.take() else {
        inner.vpn_phase = "disconnected".into();
        inner.vpn_detail = String::new();
        return Ok(());
    };
    stop_openvpn_elevated(pid)?;
    cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
    inner.managed_openvpn_log_offset = 0;
    inner.vpn_phase = "disconnected".into();
    inner.vpn_detail = "OpenVPN stopped".into();
    push_vpn_log(&mut inner, format!("Stopped OpenVPN process {pid}"));
    Ok(())
}

#[derive(serde::Serialize)]
struct VpnPoll {
    phase: String,
    detail: String,
    lines: Vec<String>,
}

/// Sync log file and return current VPN status + all log lines. Call every ~1s while active.
#[tauri::command]
fn poll_vpn(state: State<'_, AppState>) -> Result<VpnPoll, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    sync_vpn_logs(&mut inner);
    Ok(VpnPoll {
        phase: inner.vpn_phase.clone(),
        detail: inner.vpn_detail.clone(),
        lines: inner.vpn_logs.clone(),
    })
}

/// Connect to controller via direct SSH to the given VPN IP.
/// Bypasses connect.bin — opens SSH with LogLevel=ERROR and forced PTY (-tt)
/// so there's no debug noise and prompts work correctly.
#[tauri::command]
fn connect_controller(ip: String, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        kill_shell(&mut inner);
        inner.shell_logs.clear();
        inner.shell_log_cursor = 0;
        inner.shell_phase = "connecting".into();
        inner.shell_detail = format!("Connecting to root@{ip}…");
        inner.controller_ip = Some(ip.clone());
    }

    let station_key = home_ssh_dir().join("station");
    if !station_key.exists() {
        return Err(
            "SSH key not found at ~/.ssh/station. Select and start VPN bundle first.".into(),
        );
    }

    // Spawn SSH directly — no connect.bin, no verbose flags, UserKnownHostsFile=/dev/null
    // avoids host-key conflicts when controllers are replaced.
    // -tt forces PTY on remote so prompts work and echo behaves correctly.
    let mut child = Command::new("ssh")
        .args([
            "-tt",
            "-i",
            &station_key.to_string_lossy(),
            "-o", "LogLevel=ERROR",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "KexAlgorithms=ecdh-sha2-nistp521",
            &format!("root@{ip}"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn SSH: {e}"))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.shell_stdin = stdin;
        inner.shell_child = Some(child);
    }

    let arc = state.inner.clone();

    // Stdout reader — two-thread design:
    //   • A raw reader thread pumps bytes into a channel.
    //   • The processor thread receives with a 400 ms timeout so partial lines
    //     (wizard prompts like "Customer name [Shane Franklin]: ") are flushed
    //     even when the interactive program never sends a newline.
    //
    // Processing pipeline per chunk:
    //   strip_ansi → normalize CR/CRLF → split on \n → flush partial on timeout
    //
    // Shell prompts ([SID]# / $ / #) are held in `pending_prompt` and merged with
    // the immediately following PTY echo so they appear as one line, coloured as
    // "input" (prefixed with \x01) in the frontend.
    if let Some(mut stdout) = stdout {
        let arc2 = arc.clone();
        thread::spawn(move || {
            // Raw reader sub-thread sends Option<Vec<u8>>: Some(bytes) | None (EOF)
            let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) => { let _ = tx.send(None); break; }
                        Ok(n) => { let _ = tx.send(Some(buf[..n].to_vec())); }
                        Err(_) => { let _ = tx.send(None); break; }
                    }
                }
            });

            let mut partial = String::new();
            // Shell/wizard prompt: held here so the following PTY echo can be merged.
            let mut pending_prompt: Option<String> = None;
            // Set after a wizard-prompt timeout-flush so the next PTY echo is
            // marked as "input" type (accent colour, "> " prefix in the frontend).
            let mut after_timeout_flush = false;
            // Suppress the "stty cols 999" echo we send silently on first connect.
            let mut suppress_next_merge = false;

            'outer: loop {
                match rx.recv_timeout(Duration::from_millis(400)) {
                    Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        // EOF — flush any remaining partial
                        if !partial.trim().is_empty() {
                            let line = partial.trim_end_matches('\n').to_string();
                            partial.clear();
                            if let Ok(mut inner) = arc2.lock() {
                                detect_shell_connected(&mut inner, &line);
                                let _ = pending_prompt.take();
                                inner.shell_logs.push(line);
                            }
                        }
                        break 'outer;
                    }
                    Ok(Some(bytes)) => {
                        let chunk = normalize_chunk(&String::from_utf8_lossy(&bytes));

                        // Debug: log each raw normalized chunk so operators can see
                        // exactly what the controller sends and in what order.
                        if let Ok(mut inner) = arc2.lock() {
                            if inner.shell_debug {
                                let escaped = debug_escape(&chunk);
                                inner.shell_logs.push(format!("\x03[chunk: \"{escaped}\"]"));
                            }
                        }

                        partial.push_str(&chunk);

                        // Extract complete lines
                        while let Some(pos) = partial.find('\n') {
                            let line = partial[..pos].to_string();
                            partial = partial[pos + 1..].to_string();
                            // Skip empty lines but preserve after_timeout_flush —
                            // empty echo = user pressed Enter to accept default.
                            if line.is_empty() { continue; }

                            if let Ok(mut inner) = arc2.lock() {
                                // On first shell connection: silently widen the PTY so
                                // readline never hard-wraps long pre-filled defaults at
                                // col 80. Without this, the pre-fill is split across two
                                // "lines" and we can't identify / clear it correctly.
                                let was_connecting = inner.shell_phase == "connecting";
                                detect_shell_connected(&mut inner, &line);
                                if was_connecting && inner.shell_phase == "connected" {
                                    if let Some(stdin) = inner.shell_stdin.as_mut() {
                                        let _ = stdin.write_all(b"stty cols 999\n");
                                        let _ = stdin.flush();
                                    }
                                    suppress_next_merge = true;
                                }

                                if let Some(p) = pending_prompt.take() {
                                    if suppress_next_merge {
                                        // stty echo — discard silently, consume pending_prompt
                                        suppress_next_merge = false;
                                    } else if inner.shell_suppress_redraw && after_timeout_flush {
                                        // Ctrl+K redraw merged with the user's echo line.
                                        // Discard — local echo already showed the input.
                                        inner.shell_suppress_redraw = false;
                                    } else {
                                        // Shell prompt + command echo → one input line
                                        inner.shell_logs.push(format!("\x01{}{}", p, line));
                                    }
                                } else if after_timeout_flush {
                                    // Wizard prompt echo: new input-coloured entry
                                    inner.shell_logs.push(format!("\x01{}", line));
                                } else {
                                    inner.shell_logs.push(line);
                                }
                            }
                            after_timeout_flush = false;
                        }

                        // Immediate flush for prompts (# / $ / ]: / : / ?)
                        // Store as pending_prompt to merge with the incoming echo.
                        if !partial.is_empty() && looks_like_prompt(&partial) {
                            let prompt_line = partial.clone();
                            partial.clear();
                            if let Ok(mut inner) = arc2.lock() {
                                detect_shell_connected(&mut inner, &prompt_line);
                            }
                            // Push any previous un-echoed shell prompt before replacing
                            if let Some(old) = pending_prompt.take() {
                                if let Ok(mut inner) = arc2.lock() {
                                    inner.shell_logs.push(old);
                                }
                            }
                            pending_prompt = Some(prompt_line);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // No data for 400 ms — program is waiting for user input.
                        //
                        // Combine any pending WIZARD prompt label with the partial
                        // pre-fill fragment (handles programs that send the label and
                        // pre-fill in two separate writes, or the previous scenario
                        // where the combined line was wider than the old PTY columns).
                        // Shell prompts (# / $) are left alone — user is just slow.
                        let pending_is_wizard = pending_prompt
                            .as_deref()
                            .map(is_wizard_prompt)
                            .unwrap_or(false);
                        let has_partial = !partial.trim().is_empty();

                        if has_partial || pending_is_wizard {
                            let fragment = partial.trim_end_matches('\n').to_string();
                            partial.clear();

                            let raw_full = if pending_is_wizard {
                                let p = pending_prompt.take().unwrap();
                                if fragment.is_empty() { p } else { format!("{}{}", p, fragment) }
                            } else {
                                // Plain partial, no matching wizard prompt
                                let _ = pending_prompt.take();
                                fragment
                            };

                            if !raw_full.trim().is_empty() {
                                let display = strip_wizard_prefill(&raw_full).to_string();
                                let mut suppressed = false;
                                if let Ok(mut inner) = arc2.lock() {
                                    // Ctrl+K redraw arrives as a wizard-looking partial after
                                    // send_input clears a pre-fill. Suppress it — local echo
                                    // already showed the user's input.
                                    if inner.shell_suppress_redraw {
                                        inner.shell_suppress_redraw = false;
                                        suppressed = true;
                                    } else {
                                        detect_shell_connected(&mut inner, &display);
                                        // \x02 prefix → "wizard" type in frontend
                                        inner.shell_logs.push(format!("\x02{}", display));
                                        inner.shell_wizard_input = true;
                                        inner.shell_wizard_needs_clear =
                                            wizard_prompt_needs_clear(&raw_full);
                                    }
                                }
                                if !suppressed {
                                    after_timeout_flush = true;
                                }
                            }
                        }
                        // If only a shell prompt is pending, leave it — user is slow.
                    }
                }
            }

            if let Ok(mut inner) = arc2.lock() {
                if matches!(inner.shell_phase.as_str(), "connecting" | "connected") {
                    inner.shell_phase = "disconnected".into();
                    inner.shell_detail = "Connection closed".into();
                    inner.shell_logs.push("[Connection closed]".into());
                }
            }
        });
    }

    // Stderr reader — with LogLevel=ERROR only real errors appear here.
    if let Some(stderr) = stderr {
        let arc2 = arc.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if let Ok(mut inner) = arc2.lock() {
                    if inner.shell_phase == "connecting"
                        && (line.contains("Connection refused")
                            || line.contains("Permission denied")
                            || line.contains("No route to host")
                            || line.contains("Host is unreachable")
                            || line.contains("Connection timed out"))
                    {
                        inner.shell_phase = "failed".into();
                        inner.shell_detail = line.clone();
                    }
                    inner.shell_logs.push(format!("[ssh] {line}"));
                }
            }
        });
    }

    Ok(())
}

#[derive(serde::Serialize)]
struct ControllerPoll {
    phase: String,
    detail: String,
    new_lines: Vec<String>,
}

/// Returns controller connection status + any new log lines since last call.
/// ConsoleTab calls this every ~500ms to stream output.
#[tauri::command]
fn poll_controller(state: State<'_, AppState>) -> Result<ControllerPoll, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    let cursor = inner.shell_log_cursor;
    let new_lines = inner.shell_logs[cursor..].to_vec();
    inner.shell_log_cursor = inner.shell_logs.len();
    Ok(ControllerPoll {
        phase: inner.shell_phase.clone(),
        detail: inner.shell_detail.clone(),
        new_lines,
    })
}

/// Toggle raw-chunk debug logging. Returns the new state (true = on).
/// When enabled, each normalized SSH stdout chunk is pushed to shell_logs
/// as a \x03-prefixed entry so the ConsoleTab can render it as a debug line.
#[tauri::command]
fn toggle_debug(state: State<'_, AppState>) -> Result<bool, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    inner.shell_debug = !inner.shell_debug;
    Ok(inner.shell_debug)
}

/// Send Ctrl+C (interrupt byte \x03) to the active controller shell.
#[tauri::command]
fn send_interrupt(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    let Some(stdin) = inner.shell_stdin.as_mut() else {
        return Err("No active controller shell".into());
    };
    stdin.write_all(b"\x03").map_err(|e| format!("Failed to send interrupt: {e}"))?;
    stdin.flush().map_err(|e| format!("Failed to flush: {e}"))?;
    Ok(())
}

/// Write a line to the active controller shell's stdin.
/// When the previous stdout flush was a wizard prompt with a pre-filled readline
/// default, prepends \x15 (Ctrl+U) to kill the pre-filled text before inserting
/// the user's replacement — prevents "DefaultNewValue" concatenation.
#[tauri::command]
fn send_input(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    // Read and clear the wizard flag before borrowing stdin.
    let is_wizard = std::mem::replace(&mut inner.shell_wizard_input, false);
    let needs_clear = std::mem::replace(&mut inner.shell_wizard_needs_clear, false);
    // Set suppress flag before taking the stdin borrow (borrow-checker constraint).
    if is_wizard {
        // Readline often repaints the prompt immediately after submission,
        // whether we accepted the default with Enter or replaced the prefill.
        // Suppress that one-shot redraw so the console doesn't show a duplicate
        // wizard line or misclassify the repaint as fresh output.
        inner.shell_suppress_redraw = true;
    }
    let Some(stdin) = inner.shell_stdin.as_mut() else {
        return Err("No active controller shell".into());
    };
    if is_wizard && needs_clear && !text.is_empty() {
        // Send Ctrl+A (beginning-of-line) + Ctrl+K (kill-to-end) to clear the
        // editable readline pre-fill BEFORE typing the new value.
        // Choice prompts like "[Y]?" skip this and receive the raw answer.
        stdin.write_all(b"\x01\x0b").map_err(|e| format!("Failed to clear prefill: {e}"))?;
    }
    stdin
        .write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write to shell: {e}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush: {e}"))?;
    Ok(())
}

/// Disconnect the active controller shell.
#[tauri::command]
fn disconnect_controller(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    kill_shell(&mut inner);
    inner.shell_logs.push("[Disconnected]".into());
    Ok(())
}

/// Ping the target IP and check port 22 reachability for pre-flight diagnostics.
#[tauri::command]
fn run_preflight(ip: String) -> Result<serde_json::Value, String> {
    // Ping: -c 3 pings, -W 1000ms timeout per reply (macOS syntax)
    let ping_ok = Command::new("ping")
        .args(["-c", "3", "-W", "1000", &ip])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // Port 22: nc -zw1 (zero-I/O, 1s timeout)
    let port_ok = Command::new("nc")
        .args(["-zw1", &ip, "22"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let detail = match (ping_ok, port_ok) {
        (true, true)   => format!("{ip} reachable, port 22 open"),
        (true, false)  => format!("{ip} reachable but port 22 closed"),
        (false, true)  => format!("{ip} ping failed, port 22 open"),
        (false, false) => format!("{ip} unreachable"),
    };

    Ok(serde_json::json!({
        "ping_ok": ping_ok,
        "port_ok": port_ok,
        "detail": detail,
    }))
}

/// Open the active controller connection in Terminal.app for full interactive setup.
/// SSH session is wrapped with `script` to log output to ~/Desktop/fwds-{IP}-{date}.txt.
#[tauri::command]
fn open_controller_terminal(state: State<'_, AppState>) -> Result<(), String> {
    let ip = {
        let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner
            .controller_ip
            .clone()
            .ok_or_else(|| "Connect to a controller first.".to_string())?
    };

    let station_key = home_ssh_dir().join("station");
    if !station_key.exists() {
        return Err(
            "SSH key not found at ~/.ssh/station. Select and start VPN bundle first.".into(),
        );
    }

    // Log path uses shell $(date) evaluated by Terminal.app's shell at launch time
    let log_path = format!("$HOME/Desktop/fwds-{}-$(date +%Y-%m-%d).txt", ip);
    let ssh_cmd = format!(
        "ssh -tt -i {} -o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o KexAlgorithms=ecdh-sha2-nistp521 {}",
        shell_quote(&station_key.to_string_lossy()),
        shell_quote(&format!("root@{ip}")),
    );
    let command = format!(
        "clear; script -q {} {}; exit",
        shell_quote(&log_path),
        &ssh_cmd,
    );
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        applescript_string_literal(&command)
    );

    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to open Terminal: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Terminal launch failed.".into()
        } else {
            format!("Failed to open Terminal: {stderr}")
        })
    }
}

/// Lightweight status for the Session tab — does NOT advance the ConsoleTab cursor.
#[tauri::command]
fn get_controller_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    Ok(serde_json::json!({
        "phase": inner.shell_phase,
        "detail": inner.shell_detail,
    }))
}

/// App-wide snapshot for the header status bar.
#[tauri::command]
fn get_app_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    Ok(serde_json::json!({
        "vpn_phase": inner.vpn_phase,
        "shell_phase": inner.shell_phase,
        "controller_ip": inner.controller_ip,
    }))
}

// ── VPN helpers ───────────────────────────────────────────────────────────────

/// Kill any previously managed openvpn, clear VPN state, return known PIDs to kill atomically.
fn reset_vpn_state(state: &AppState) -> Result<Vec<u32>, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    let mut pids = detect_openvpn_pids();
    if let Some(pid) = inner.managed_openvpn_pid.take() {
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    inner.managed_openvpn_log_offset = 0;
    cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
    inner.vpn_logs.clear();
    inner.vpn_phase = "disconnected".into();
    inner.vpn_detail = String::new();
    Ok(pids)
}

fn stage_bundle(folder_path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(folder_path);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stage_dir = PathBuf::from(format!("/private/tmp/fwds-vpn-stage-{ts}"));

    fs::create_dir_all(&stage_dir)
        .map_err(|e| format!("Failed to create stage directory: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&stage_dir, fs::Permissions::from_mode(0o700));
    }

    for file_name in REQUIRED_FILES {
        let src = source.join(file_name);
        if !src.exists() {
            continue;
        }
        let dst = stage_dir.join(file_name);
        fs::copy(&src, &dst)
            .map_err(|e| format!("Failed to copy {file_name} to stage: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if *file_name == "connect.bin" || *file_name == "connect-local.bin" {
                0o755
            } else {
                0o644
            };
            let _ = fs::set_permissions(&dst, fs::Permissions::from_mode(mode));
        }
    }

    // Rewrite ovpn.conf so ca/cert/key use relative filenames only
    let raw_config = fs::read_to_string(source.join("ovpn.conf"))
        .map_err(|e| format!("Failed to read ovpn.conf: {e}"))?;
    let patched = rewrite_ovpn_config(&raw_config, &source, &stage_dir)?;
    fs::write(stage_dir.join("ovpn.conf"), patched)
        .map_err(|e| format!("Failed to write staged ovpn.conf: {e}"))?;

    // Copy station key to ~/.ssh/station with 0600
    let station_src = source.join("station");
    if station_src.exists() {
        let ssh_dir = home_ssh_dir();
        let _ = fs::create_dir_all(&ssh_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700));
        }
        let station_dst = ssh_dir.join("station");
        fs::copy(&station_src, &station_dst)
            .map_err(|e| format!("Failed to copy station key to ~/.ssh/station: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&station_dst, fs::Permissions::from_mode(0o600));
        }
    }

    Ok(stage_dir)
}

fn rewrite_ovpn_config(config: &str, source: &Path, stage_dir: &Path) -> Result<String, String> {
    let mut lines = Vec::new();
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            lines.push(line.to_string());
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let key = parts.next().unwrap_or_default();
        if ["ca", "cert", "key"].contains(&key) {
            if let Some(raw_val) = parts.next() {
                let raw_val = raw_val.trim_matches('"');
                let resolved = if Path::new(raw_val).is_absolute() {
                    PathBuf::from(raw_val)
                } else {
                    source.join(raw_val)
                };
                let filename = resolved
                    .file_name()
                    .ok_or_else(|| format!("Bad {key} path in ovpn.conf: {raw_val}"))?;
                let staged = stage_dir.join(filename);
                if resolved.exists() && !staged.exists() {
                    fs::copy(&resolved, &staged)
                        .map_err(|e| format!("Failed to copy {key} file into stage: {e}"))?;
                }
                lines.push(format!("{key} {}", filename.to_string_lossy()));
                continue;
            }
        }
        lines.push(line.to_string());
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn home_ssh_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".ssh"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/.ssh"))
}

fn vpn_log_path() -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    PathBuf::from(format!("/private/tmp/fwds-openvpn-{ts}.log"))
}

fn resolve_openvpn() -> Result<PathBuf, String> {
    for candidate in &[
        "/opt/homebrew/sbin/openvpn",
        "/usr/local/sbin/openvpn",
        "/usr/sbin/openvpn",
    ] {
        if Path::new(candidate).exists() {
            return Ok(PathBuf::from(candidate));
        }
    }
    let out = Command::new("which")
        .arg("openvpn")
        .output()
        .map_err(|e| format!("Failed to locate openvpn: {e}"))?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    Err("openvpn not found. Install with: brew install openvpn".into())
}

fn write_launcher_script(
    stage_dir: &Path,
    config_path: &Path,
    log_path: &Path,
    openvpn_binary: &Path,
) -> Result<PathBuf, String> {
    let launcher = stage_dir.join("start-openvpn.sh");
    let script = format!(
        "#!/bin/sh\n{} --cd {} --config {} >> {} 2>&1 </dev/null &\necho $!\n",
        shell_quote(&openvpn_binary.to_string_lossy()),
        shell_quote(&stage_dir.to_string_lossy()),
        shell_quote(&config_path.to_string_lossy()),
        shell_quote(&log_path.to_string_lossy()),
    );
    fs::write(&launcher, &script)
        .map_err(|e| format!("Failed to write launcher script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to make launcher executable: {e}"))?;
    }
    Ok(launcher)
}

fn launch_openvpn_elevated(launcher: &Path, existing_pids: &[u32]) -> Result<u32, String> {
    let launcher_quoted = shell_quote(&launcher.to_string_lossy());
    let shell_command = if existing_pids.is_empty() {
        launcher_quoted
    } else {
        format!(
            "kill {} >/dev/null 2>&1; {}",
            existing_pids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(" "),
            launcher_quoted
        )
    };
    let script = format!(
        "do shell script \"/bin/sh -c \" & quoted form of {} with administrator privileges",
        applescript_string_literal(&shell_command)
    );

    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to invoke osascript: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Administrator approval was denied or cancelled.".into()
        } else {
            format!("Failed to start OpenVPN with administrator privileges: {stderr}")
        });
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("Unexpected output from osascript: '{}'", stdout.trim()))
}

fn stop_openvpn_elevated(pid: u32) -> Result<(), String> {
    let script = format!(
        "do shell script \"kill {}\" with administrator privileges",
        pid
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to invoke osascript to stop OpenVPN: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.contains("No such process") {
        Ok(())
    } else if stderr.is_empty() {
        Err("Failed to stop the elevated OpenVPN process.".into())
    } else {
        Err(format!("Failed to stop OpenVPN: {stderr}"))
    }
}

fn sync_vpn_logs(inner: &mut InnerState) {
    let Some(ref log_path) = inner.managed_openvpn_log_path.clone() else {
        return;
    };
    let Ok(mut file) = fs::File::open(log_path) else {
        return;
    };
    if file.seek(SeekFrom::Start(inner.managed_openvpn_log_offset)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    inner.managed_openvpn_log_offset += buf.len() as u64;

    for line in buf.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        update_vpn_status(inner, line);
        inner.vpn_logs.push(line.to_string());
    }

    // Detect openvpn death while still "connecting"
    if let Some(pid) = inner.managed_openvpn_pid {
        if inner.vpn_phase == "connecting" && !process_alive(pid) {
            inner.managed_openvpn_pid = None;
            cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
            inner.vpn_phase = "failed".into();
            inner.vpn_detail = "OpenVPN exited before the tunnel was established".into();
            inner.vpn_logs.push(inner.vpn_detail.clone());
        }
    }
}

fn update_vpn_status(inner: &mut InnerState, line: &str) {
    if line.contains("Initialization Sequence Completed") {
        inner.vpn_phase = "connected".into();
        inner.vpn_detail = "OpenVPN tunnel established".into();
    } else if (line.contains("Operation not permitted") && line.contains("utun"))
        || line.contains("Cannot allocate TUN/TAP dev dynamically")
    {
        inner.vpn_phase = "failed".into();
        inner.vpn_detail =
            "OpenVPN could not create the tunnel device — administrator privileges required."
                .into();
    } else if line.contains("AUTH_FAILED")
        || line.contains("Exiting due to fatal error")
        || line.contains("fatal error")
    {
        inner.vpn_phase = "failed".into();
        inner.vpn_detail = line.to_string();
    }
}

fn detect_openvpn_pids() -> Vec<u32> {
    Command::new("pgrep")
        .args(["-x", "openvpn"])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn process_alive(pid: u32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .output()
        .ok()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn push_vpn_log(inner: &mut InnerState, msg: String) {
    inner.vpn_logs.push(msg);
}

fn cleanup_stage_dir(path: Option<String>) {
    if let Some(p) = path {
        let _ = fs::remove_dir_all(p);
    }
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

/// Marks the shell as "connected" when a prompt line is seen.
fn detect_shell_connected(inner: &mut InnerState, line: &str) {
    if inner.shell_phase == "connecting" && looks_like_prompt(line) {
        inner.shell_phase = "connected".into();
        inner.shell_detail = "Controller shell ready".into();
    }
}

/// Returns true if the string looks like a shell prompt ($ or # — command mode).
fn is_shell_prompt(s: &str) -> bool {
    s.ends_with("# ") || s.ends_with("$ ")
}

/// Returns true if the string looks like an interactive wizard prompt (field label).
/// These may appear with a pre-filled default that we need to clear before typing.
fn is_wizard_prompt(s: &str) -> bool {
    s.ends_with("]: ") || s.ends_with(": ") || s.ends_with("? ")
}

/// Either a shell or wizard prompt — causes the string to be held for echo-merge.
fn looks_like_prompt(s: &str) -> bool {
    is_shell_prompt(s) || is_wizard_prompt(s)
}

/// Strip ANSI escape sequences from a string.
/// Cursor-positioning / clear sequences (H, J, f) are replaced with '\n' so that
/// ncurses-style UIs don't smear all their text onto one line.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next(); // consume '['
                    let mut terminator = ' ';
                    for c2 in chars.by_ref() {
                        if c2.is_ascii_alphabetic() {
                            terminator = c2;
                            break;
                        }
                    }
                    // Cursor-positioning / screen-clear → inject a newline so text doesn't run together
                    if matches!(terminator, 'H' | 'J' | 'f') {
                        result.push('\n');
                    }
                }
                Some('(' | ')' | '#') => {
                    chars.next(); // skip designator char
                    chars.next(); // skip following char
                }
                Some(c2) if c2.is_ascii_alphabetic() => {
                    chars.next(); // e.g. ESC c (reset)
                }
                _ => {} // lone ESC — drop it, keep whatever follows
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Normalize a raw PTY chunk: strip ANSI, convert CRLF→LF, simulate CR overwrite,
/// and process backspace characters (\x08).
/// The returned string preserves the absence of a trailing '\n' on partial lines.
fn normalize_chunk(raw: &str) -> String {
    let stripped = strip_ansi(raw);
    // CRLF → LF first
    let s = stripped.replace("\r\n", "\n");
    // Within each LF-delimited segment:
    //   • bare CR means "overwrite from col 0" → keep last CR-separated piece
    //   • \x08 (backspace) erases the preceding character
    let segs: Vec<&str> = s.split('\n').collect();
    let norm: Vec<String> = segs
        .iter()
        .map(|seg| {
            let cr_last = seg.split('\r').last().unwrap_or("");
            // Apply backspaces
            let mut out: Vec<char> = Vec::with_capacity(cr_last.len());
            for c in cr_last.chars() {
                if c == '\x08' {
                    out.pop();
                } else {
                    out.push(c);
                }
            }
            out.into_iter().collect()
        })
        .collect();
    norm.join("\n")
}

/// For wizard prompts like "    Name [Default]: Default text",
/// strip the pre-filled default after the last "]: " so only the prompt label remains.
/// Also handles choice prompts like "...(A-Add, R-Replace, U-Use) [U]? U"
/// where the pre-fill follows a "? " ending.
fn strip_wizard_prefill(s: &str) -> &str {
    if let Some(idx) = s.rfind("]: ") {
        return &s[..idx + 3];
    }
    // Choice prompts: e.g. "Add, Replace, Use) [U]? U" → strip after last "? "
    if let Some(idx) = s.rfind("? ") {
        return &s[..idx + 2];
    }
    s
}

fn wizard_prompt_needs_clear(s: &str) -> bool {
    strip_wizard_prefill(s) != s
}

/// Escape a normalized chunk for debug display: makes whitespace and control
/// characters visible so operators can see exactly what arrived from SSH.
fn debug_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        match c {
            '\n' => out.push_str("↵"),
            '\r' => out.push_str("←"),
            '\t' => out.push_str("→"),
            '\x01'..='\x1f' => {
                out.push('^');
                out.push((b'@' + c as u8) as char);
            }
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out
}

fn kill_shell(inner: &mut InnerState) {
    inner.shell_stdin = None;
    if let Some(mut child) = inner.shell_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.shell_wizard_input = false;
    inner.shell_wizard_needs_clear = false;
    inner.shell_suppress_redraw = false;
    inner.shell_phase = "disconnected".into();
    inner.shell_detail = String::new();
}

// ── String helpers ────────────────────────────────────────────────────────────

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn applescript_string_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// ── App setup ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            inner: Arc::new(Mutex::new(InnerState::default())),
        })
        .invoke_handler(tauri::generate_handler![
            select_vpn_folder,
            validate_bundle,
            start_vpn,
            stop_vpn,
            poll_vpn,
            connect_controller,
            get_controller_status,
            poll_controller,
            send_input,
            send_interrupt,
            toggle_debug,
            disconnect_controller,
            run_preflight,
            open_controller_terminal,
            get_app_state,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
