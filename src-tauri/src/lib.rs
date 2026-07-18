use serialport::SerialPort;
#[cfg(target_os = "windows")]
use serialport::SerialPortType;
#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use mdns_sd::{ServiceDaemon, ServiceEvent};
#[cfg(target_os = "windows")]
use rsa::pkcs1::DecodeRsaPrivateKey;
#[cfg(target_os = "windows")]
use ssh_key::{sha2::{Digest, Sha256}, Mpint, PrivateKey};
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "windows")]
use std::io::ErrorKind as IoErrorKind;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, TRUE, WPARAM};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowThreadProcessId, PostMessageW, WM_CHAR,
};

mod parsers;

use parsers::parse_log_into_state;

const VPN_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const VPN_STOP_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(target_os = "windows")]
const VPN_STALE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(4);
const VPN_LOG_LIMIT: usize = 500;

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct InnerState {
    // VPN (OpenVPN managed as elevated root process)
    managed_openvpn_pid: Option<u32>,
    managed_openvpn_log_path: Option<String>,
    managed_openvpn_log_offset: u64,
    managed_openvpn_stage_dir: Option<String>,
    vpn_phase: String, // disconnected | starting | connected | stopping | failed | unknown
    vpn_detail: String,
    vpn_logs: Vec<String>,
    vpn_transition_in_flight: bool,
    vpn_transition_token: u64,
    vpn_cancel_requested: bool,

    // Controller shell (SSH session)
    shell_child: Option<Child>,
    shell_stdin: Option<ChildStdin>,
    shell_phase: String, // disconnected | connecting | connected | failed
    shell_detail: String,
    controller_ip: Option<String>,
    local_serial_device: Option<String>,
    connection_mode: String, // vpn | local
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

    // External Terminal.app session target (window id) used by Send buttons.
    external_terminal_window_id: Option<i64>,
    windows_local_terminal_child: Option<Child>,
    windows_local_serial_writer: Option<Arc<Mutex<Box<dyn SerialPort>>>>,
    windows_local_serial_kill: Option<Arc<AtomicBool>>,

    // SD card flashing (elevated dd / raw write of a firmware image)
    sd_flash_phase: String, // idle | preparing | writing | flushing | verifying | ejecting | done | failed | cancelled
    sd_flash_detail: String,
    // Real failure reason (e.g. dd's stderr), persisted across poll cycles so the
    // FLASH_EXIT line — which may be read in a later poll than WRITE_FAIL — keeps it.
    sd_flash_fail_detail: Option<String>,
    sd_flash_pid: Option<u32>,
    sd_flash_progress_path: Option<String>,
    sd_flash_stage_dir: Option<String>,
    sd_flash_progress_offset: u64,
    sd_flash_logs: Vec<String>,
    sd_flash_comp_total: u64, // compressed source size — denominator for the exact percent
    sd_flash_comp_done: u64,  // compressed bytes consumed so far
    sd_flash_bytes_done: u64, // decompressed bytes written so far
    sd_flash_rate_bps: u64,
    sd_flash_compressed: bool,
    sd_flash_in_flight: bool,
    sd_flash_cancel_requested: bool,
}

struct AppState {
    inner: Arc<Mutex<InnerState>>,
    diagnostic_state: Arc<Mutex<DiagnosticState>>,
    log_watcher_kill: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    watcher_paused: Arc<AtomicBool>,
    watcher_pause_offset: Arc<Mutex<u64>>,
    diagnostic_store: Arc<Mutex<DiagnosticStore>>,
    current_controller_key: Arc<Mutex<Option<String>>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct DiagnosticState {
    pub wifi: Option<WifiDiagnostic>,
    pub cellular: Option<CellularDiagnostic>,
    pub satellite: Option<SatelliteDiagnostic>,
    pub ethernet: Option<EthernetDiagnostic>,
    pub pressure: Option<PressureDiagnostic>,
    pub system: Option<SystemDiagnostic>,
    pub sim_picker: Option<SimPickerDiagnostic>,
    pub interface_runs: HashMap<String, InterfaceRunState>,
    pub last_updated: Option<String>,
    pub session_has_data: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct InterfaceRunState {
    pub in_progress: bool,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub last_marker: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub enum SimPickerRecommendation {
    #[default]
    NotRun,
    ScanFailed,
    DeadZone,
    KeepCurrent,
    WeakButBest,
    SwapTo(String),
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct SimPickerDiagnostic {
    // Run metadata
    pub scan_attempted: bool,
    pub scan_completed: bool,
    pub scan_failed: bool,
    pub scan_empty: bool,
    pub full_block_run: bool,

    // Installed SIM
    pub installed_iccid: Option<String>,
    pub installed_imsi: Option<String>,
    pub installed_carrier_code: Option<String>,
    pub installed_carrier_name: Option<String>,

    // Scan results
    pub detected_networks: Vec<CopsNetwork>,
    pub nwscanmode: Option<u8>,

    // Derived recommendation
    pub best_network_code: Option<String>,
    pub best_network_name: Option<String>,
    pub installed_carrier_detected: bool,
    pub current_registered_code: Option<String>, // from +QNWINFO — MCC-MNC modem is on
    pub recommendation: SimPickerRecommendation,
    pub recommendation_detail: String,

    pub qcsq_rsrp: Option<i32>,

    pub last_updated: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct WifiDiagnostic {
    pub status: DiagStatus,
    pub summary: String,

    pub check_result: String,
    pub check_error: Option<String>,
    pub internet_reachable: bool,
    pub wifi_state: String,
    pub access_point: Option<String>,
    pub strength_score: Option<u8>,
    pub strength_label: Option<String>,
    pub ipv4: bool,
    pub ipv6: bool,
    pub dns_servers: String,
    pub check_avg_latency_ms: Option<f64>,
    pub check_packet_loss_pct: u8,

    pub signal_dbm: Option<i32>,
    pub signal_dbm_trusted: bool,

    pub interface_exists: bool,
    pub interface_name: Option<String>,
    pub interface_type: Option<String>,
    pub mac_address: Option<String>,
    pub ssid: Option<String>,
    pub tx_power_dbm: Option<f64>,

    pub connected: Option<bool>,
    pub ap_bssid: Option<String>,
    pub frequency_mhz: Option<u32>,
    pub tx_bitrate_mbps: Option<f64>,
    pub link_rx_bytes: Option<u64>,
    pub link_rx_packets: Option<u64>,
    pub link_tx_bytes: Option<u64>,
    pub link_tx_packets: Option<u64>,

    pub station_signal_dbm: Option<i32>,
    pub station_tx_retries: Option<u64>,
    pub station_tx_failed: Option<u64>,
    pub station_tx_bitrate_mbps: Option<f64>,

    pub lower_up_flag: Option<bool>,
    pub link_state: Option<String>,

    pub ipv4_address: Option<String>,
    pub ipv4_prefix: Option<u8>,

    pub default_via_wlan0: Option<bool>,
    pub default_gateway: Option<String>,

    pub connman_wifi_powered: Option<bool>,
    pub connman_wifi_connected: Option<bool>,
    pub connman_eth_connected: Option<bool>,
    pub connman_cell_connected: Option<bool>,

    pub connman_active_service: Option<String>,
    pub connman_wifi_active: Option<bool>,
    pub connman_state: Option<String>,

    pub driver: Option<String>,
    pub driver_version: Option<String>,
    pub bus_info: Option<String>,

    pub proc_rx_bytes: Option<u64>,
    pub proc_rx_packets: Option<u64>,
    pub proc_rx_errs: Option<u64>,
    pub proc_rx_drop: Option<u64>,
    pub proc_tx_bytes: Option<u64>,
    pub proc_tx_packets: Option<u64>,
    pub proc_tx_errs: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CopsNetwork {
    pub stat: u8,
    pub long_name: String,
    pub numeric: String,
    pub act: u8,
    pub resolved_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CellularDiagnostic {
    pub status: DiagStatus,
    pub summary: String,

    pub controller_sid: Option<String>,
    pub controller_version: Option<String>,
    pub controller_date: Option<String>,

    pub check_result: String,
    pub check_error: Option<String>,
    pub internet_reachable: bool,
    pub cell_state: String,
    pub provider_code: Option<String>,
    pub strength_score: Option<u8>,
    pub strength_label: Option<String>,
    pub ipv4: bool,
    pub ipv6: bool,
    pub dns_servers: String,
    pub check_avg_latency_ms: Option<f64>,
    pub check_packet_loss_pct: u8,

    pub imei: Option<String>,
    pub iccid: Option<String>,
    pub imsi: Option<String>,
    pub hni: Option<String>,
    pub basic_provider: Option<String>,
    pub basic_status: Option<String>,
    pub basic_signal: Option<String>,
    pub basic_apn: Option<String>,

    pub connman_cell_powered: Option<bool>,
    pub connman_cell_connected: Option<bool>,
    pub connman_wifi_connected: Option<bool>,
    pub connman_eth_connected: Option<bool>,
    pub connman_active_service: Option<String>,
    pub connman_cell_active: Option<bool>,
    pub connman_cell_ready: Option<bool>,
    pub connman_state: Option<String>,

    pub wwan_exists: bool,
    pub wwan_link_state: Option<String>,
    pub wwan_lower_up: Option<bool>,
    pub wwan_ipv4_address: Option<String>,
    pub wwan_ipv4_prefix: Option<u8>,
    pub default_via_wwan0: Option<bool>,
    pub default_gateway: Option<String>,
    pub role: Option<String>,

    pub proc_rx_bytes: Option<u64>,
    pub proc_rx_packets: Option<u64>,
    pub proc_rx_errs: Option<u64>,
    pub proc_rx_drop: Option<u64>,
    pub proc_tx_bytes: Option<u64>,
    pub proc_tx_packets: Option<u64>,
    pub proc_tx_errs: Option<u64>,

    pub modem_present: Option<bool>,
    pub modem_model: Option<String>,
    pub modem_revision: Option<String>,
    pub sim_ready: Option<bool>,
    pub sim_inserted: Option<bool>,
    pub cfun: Option<u8>,
    pub registered: Option<bool>,
    pub attached: Option<bool>,
    pub operator_name: Option<String>,
    pub qcsq: Option<String>,
    pub rssi_dbm: Option<i32>,
    pub rat: Option<String>,
    pub mccmnc: Option<String>,
    pub band: Option<String>,
    pub channel: Option<String>,
    pub pdp_active: Option<bool>,
    pub pdp_ip: Option<String>,
    pub at_apn: Option<String>,

    pub recommended_action: Option<String>,
    pub other_actions: Vec<String>,
    pub full_block_run: bool,
    pub modem_not_present: bool,

    // modem_unreachable state: hardware visible but AT interface dead / setup timed out
    pub modem_unreachable: bool,
    pub setup_attempted: bool,
    pub setup_timed_out: bool,
    pub at_interface_failed: Option<bool>,
    pub cellular_disabled: bool,
    pub no_service: bool,
    pub sim_present: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SatelliteDiagnostic {
    pub status: DiagStatus,
    pub summary: String,

    // Controller context
    pub controller_sid: Option<String>,
    pub controller_version: Option<String>,
    pub controller_date: Option<String>,

    // Modem identity
    pub sat_imei: Option<String>,
    pub modem_present: Option<bool>,

    // ConnMan / system context
    pub connman_state: Option<String>,
    pub connman_eth_connected: Option<bool>,
    pub connman_wifi_connected: Option<bool>,
    pub connman_cell_connected: Option<bool>,
    pub connman_active_service: Option<String>,

    // Interface / routing context
    pub default_gateway: Option<String>,
    pub default_via_eth0: Option<bool>,
    pub default_via_wlan0: Option<bool>,
    pub default_via_wwan0: Option<bool>,

    // Optional telemetry/context hook
    pub satellites_seen: Option<f64>,

    // Light test
    pub light_test_ran: bool,
    pub light_test_success: Option<bool>,
    pub light_test_timeout: Option<bool>,
    pub light_test_blocked_in_use: Option<bool>,
    pub light_test_error: Option<String>,

    // Full / loopback test
    pub loopback_test_ran: bool,
    pub loopback_test_success: Option<bool>,
    pub loopback_test_timeout: Option<bool>,
    pub loopback_test_blocked_in_use: Option<bool>,
    pub loopback_test_error: Option<String>,

    // Loopback metrics
    pub station_sent_epoch: Option<i64>,
    pub server_sent_epoch: Option<i64>,
    pub current_epoch: Option<i64>,
    pub total_time_seconds: Option<u64>,
    pub loopback_duration_seconds: Option<f64>,
    pub loopback_packet_loss_pct: Option<u8>,
    pub satellite_state: Option<String>,

    // Recommended actions
    pub recommended_action: Option<String>,
    pub other_actions: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct EthernetDiagnostic {
    pub status: DiagStatus,
    pub summary: String,
    #[serde(default)]
    pub technology_disabled: bool,
    pub internet_reachable: bool,
    pub eth_state: String,
    pub ipv4: bool,
    pub ipv6: bool,
    pub dns_servers: String,
    pub ip_address: Option<String>,
    pub netmask: Option<String>,
    pub speed: Option<String>,
    pub duplex: Option<String>,
    pub link_detected: Option<bool>,
    pub rx_errors: u64,
    pub tx_errors: u64,
    pub rx_dropped: u64,
    pub check_result: String,
    pub flap_count: u32,
    pub full_block_run: bool,
    pub ethernet_diag_attempted: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureDiagnostic {
    pub status: DiagStatus,
    pub summary: String,
    pub via_sensor: Option<String>,
    pub display_psi: Option<f64>,
    pub controller_id: Option<String>,
    pub fw_version: Option<String>,
    pub system_type: Option<String>,
    pub is_active: bool,
    pub sensors: PressureSensors,
    pub sensor_errors: Vec<PressureSensorError>,
    pub asserts: Vec<PressureAssertRecord>,
    pub issues: Vec<PressureIssue>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureSensors {
    pub source: Option<PressureSensorReading>,
    pub distribution: Option<PressureSensorReading>,
    pub supply: Option<PressureSensorReading>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureSensorReading {
    pub name: String,
    pub index: u8,
    pub readings: Vec<f64>,
    pub snapshot: f64,
    pub latest: f64,
    pub mean: f64,
    pub min: f64,
    pub max: f64,
    pub stdev: f64,
    pub count: usize,
    pub voltage: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureSensorError {
    pub sensor_index: u8,
    pub message: String,
    pub errno: i32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureAssertRecord {
    pub file: String,
    pub line: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct PressureIssue {
    pub id: String,
    pub severity: DiagStatus,
    pub title: String,
    pub description: String,
    pub action: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct SystemDiagnostic {
    pub sid: Option<String>,
    pub imei: Option<String>,
    pub version: Option<String>,
    pub controller_date: Option<String>,
    pub release_date: Option<String>,
    pub display_name: Option<String>,
    pub location: Option<String>,
    pub system_name: Option<String>,
    pub preferred_network: Option<String>,
    pub preferred_network_service_type: Option<String>,
    pub install_date: Option<String>,
    pub system_type: Option<String>,
    pub hydraulic_hardware_configuration: Option<String>,
    pub foam_module: Option<bool>,
    pub no_foam_system: Option<bool>,
    pub drain_cycle: Option<bool>,
    pub drain_during_deactivation: Option<bool>,
    pub initiation_cycles: Option<u32>,
    pub water_use_mode: Option<String>,
    pub zone_count: Option<u32>,
    pub zones: Vec<SystemZone>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
pub struct SystemZone {
    pub number: Option<u32>,
    pub zone_type: Option<String>,
    pub name: Option<String>,
    pub motor_driver: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiagStatus {
    #[default]
    Unknown,
    Grey,
    Green,
    Orange,
    Red,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct DiagnosticStore {
    controllers: HashMap<String, DiagnosticState>,
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

// ── Session transcript logging ──────────────────────────────────────────────
//
// Transcripts are stored in the app's *private* per-user data directory — never
// the Desktop or Documents, which on macOS sync to iCloud. The directory is
// created 0700 on Unix; on Windows we rely on the default per-user ACLs of
// %LOCALAPPDATA%. Logging is opt-out (`TRANSCRIPT_LOGGING`), secret values are
// redacted before they touch disk (`redact_secrets`), files roll over past a
// size ceiling, and stale files are pruned on launch (`prune_old_transcripts`).

/// Bundle identifier — matches `identifier` in tauri.conf.json. Scopes our
/// files under the platform's per-user app-data directory.
const APP_IDENTIFIER: &str = "com.frontlinewildfire.controller-console";

/// Days a transcript is kept before it is pruned on the next launch.
const TRANSCRIPT_RETENTION_DAYS: u64 = 14;

/// Per-file size ceiling; the file rolls over to `<name>.1` once exceeded.
const TRANSCRIPT_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Whether plaintext session transcripts are written to disk. Mirrors the
/// persisted `AppSettings::transcript_logging_enabled` so hot paths
/// (`append_transcript`, the Windows PuTTY spawns) can check it lock-free.
static TRANSCRIPT_LOGGING: AtomicBool = AtomicBool::new(true);

/// Cross-chunk redaction state. The macOS SSH reader streams stdout in chunks
/// that can split a "password:" prompt from the value echoed on the next chunk,
/// so we carry an "armed" flag between `append_transcript` calls.
static REDACT_STATE: Mutex<RedactState> = Mutex::new(RedactState { armed: false });

/// The app's private per-user data directory (parent of `logs/`).
fn app_data_dir() -> PathBuf {
    let base = dirs::data_local_dir()
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join(APP_IDENTIFIER)
}

fn controller_logs_dir() -> PathBuf {
    let dir = app_data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    harden_dir_permissions(&dir);
    dir
}

/// Restrict a directory (and its app-data parent) to the owner on Unix. No-op
/// on Windows, where the default ACLs on %LOCALAPPDATA% are already per-user.
fn harden_dir_permissions(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        if let Some(parent) = dir.parent() {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn log_file_path(ip: &str) -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let filename = format!("fwds-{}-{}.txt", ip, date);
    controller_logs_dir().join(filename)
}

fn local_serial_log_file(device: &str) -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let safe = device
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let filename = format!("fwds-serial-{}-{}.txt", safe, date);
    controller_logs_dir().join(filename)
}

fn append_transcript(path: &Path, text: &str) {
    if text.is_empty() || !TRANSCRIPT_LOGGING.load(Ordering::Relaxed) {
        return;
    }
    let redacted = {
        let mut state = REDACT_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        redact_secrets(&mut state, text)
    };
    // Roll over once the file grows past the ceiling so a long session can't
    // produce an unbounded plaintext file.
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > TRANSCRIPT_MAX_BYTES {
            let rotated = rotated_transcript_path(path);
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(path, &rotated);
        }
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        harden_file_permissions(&file);
        let _ = file.write_all(redacted.as_bytes());
        let _ = file.flush();
    }
}

fn rotated_transcript_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "transcript.txt".into());
    path.with_file_name(format!("{name}.1"))
}

fn harden_file_permissions(file: &fs::File) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = file;
}

// ── Transcript redaction ────────────────────────────────────────────────────

/// Marker written in place of a redacted secret.
const REDACTED: &str = "••••[redacted]";

/// Case-insensitive keywords that mark a line as carrying (or prompting for) a
/// secret. Kept deliberately narrow to avoid masking useful diagnostics.
const SECRET_KEYWORDS: &[&str] = &["password", "passphrase", "pre-shared", "psk"];

struct RedactState {
    /// True when a preceding line ended at a secret prompt (e.g. "password:"),
    /// so the next line is the value being echoed back and must be masked.
    armed: bool,
}

fn line_has_secret_keyword(lower: &str) -> bool {
    SECRET_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// Redact secret values from transcript text before it is written to disk.
///
/// Handles three shapes:
///   • inline   — `password: hunter2`  → `password: ••••[redacted]`
///   • pre-fill — `passphrase [old]: `  → `passphrase [••••[redacted]]: `
///   • split    — `wifi password:` in one chunk, `hunter2` in the next
///
/// `state.armed` carries the split case across calls because the macOS SSH
/// reader can deliver the prompt and the echoed value in separate chunks.
fn redact_secrets(state: &mut RedactState, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut segments = text.split('\n').peekable();
    while let Some(seg) = segments.next() {
        let newline_after = segments.peek().is_some();

        // The value echoed back after an armed secret prompt.
        if state.armed {
            if !seg.is_empty() {
                out.push_str(REDACTED);
            }
            // The echoed value ends once its line terminates; disarm then.
            if newline_after {
                state.armed = false;
                out.push('\n');
            }
            continue;
        }

        let lower = seg.to_ascii_lowercase();
        if line_has_secret_keyword(&lower) {
            out.push_str(&redact_keyword_segment(seg));
            // Arm when the line is a prompt awaiting a value on the next line,
            // i.e. it ends at a ':' / '?' separator with nothing after it.
            let trimmed = seg.trim_end();
            if trimmed.ends_with(':') || trimmed.ends_with('?') {
                state.armed = true;
            }
        } else {
            out.push_str(seg);
        }
        if newline_after {
            out.push('\n');
        }
    }
    out
}

/// Redact the secret portion of a single line already known to contain a
/// keyword: the value after the field separator and any bracketed pre-fill.
fn redact_keyword_segment(seg: &str) -> String {
    let lower = seg.to_ascii_lowercase();
    // End index of the secret keyword nearest the value (rightmost match), so
    // the separator we key off belongs to the field and not an earlier colon.
    let Some(kw_end) = SECRET_KEYWORDS
        .iter()
        .filter_map(|kw| lower.rfind(kw).map(|pos| pos + kw.len()))
        .max()
    else {
        return seg.to_string();
    };

    match seg[kw_end..].find([':', '=', '?']) {
        Some(rel) => {
            let sep = kw_end + rel;
            let sep_ch = seg[sep..].chars().next().unwrap_or(':');
            let label = mask_bracketed(&seg[..sep]);
            let value = &seg[sep + sep_ch.len_utf8()..];
            if value.trim().is_empty() {
                format!("{label}{sep_ch}{value}")
            } else {
                let lead = value.len() - value.trim_start().len();
                format!("{label}{sep_ch}{}{REDACTED}", &value[..lead])
            }
        }
        // Keyword with a bracketed pre-fill but no separator on this line.
        None => mask_bracketed(seg),
    }
}

/// Replace the contents of the first `[...]` pre-fill with the redaction marker.
fn mask_bracketed(s: &str) -> String {
    if let (Some(open), Some(close)) = (s.find('['), s.rfind(']')) {
        if close > open + 1 && !s[open + 1..close].trim().is_empty() {
            return format!("{}[{}]{}", &s[..open], REDACTED, &s[close + 1..]);
        }
    }
    s.to_string()
}

// ── Transcript retention / migration ────────────────────────────────────────

/// Remove transcripts older than the retention window. Called on launch so a
/// laptop doesn't accumulate customer PII indefinitely.
fn prune_old_transcripts() {
    let dir = controller_logs_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let Some(cutoff) = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60))
    else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if modified < cutoff {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Best-effort one-time relocation of transcripts written by older builds to
/// the (unsafe) Desktop/Documents location. Moves them into the private dir so
/// pre-existing customer PII stops syncing to iCloud. Never deletes log data.
fn migrate_legacy_transcripts() {
    let dest = controller_logs_dir();
    let legacy_dirs = [dirs::desktop_dir(), dirs::document_dir()]
        .into_iter()
        .flatten()
        .map(|base| base.join("FWDS Controller Logs"));

    for legacy in legacy_dirs {
        if legacy == dest || !legacy.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&legacy) {
            for entry in entries.flatten() {
                let from = entry.path();
                let Some(name) = from.file_name() else { continue };
                if !from.is_file() {
                    continue;
                }
                let mut to = dest.join(name);
                if to.exists() {
                    to = dest.join(format!("{}.legacy", name.to_string_lossy()));
                }
                // Prefer rename; fall back to copy+remove across volumes.
                if fs::rename(&from, &to).is_err() && fs::copy(&from, &to).is_ok() {
                    let _ = fs::remove_file(&from);
                }
            }
        }
        // Remove the legacy dir only if it is now empty.
        let _ = fs::remove_dir(&legacy);
    }
}

// ── App settings ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AppSettings {
    #[serde(default = "default_true")]
    transcript_logging_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            transcript_logging_enabled: true,
        }
    }
}

fn app_settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

fn load_app_settings() -> AppSettings {
    match fs::read_to_string(app_settings_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

fn save_app_settings(settings: &AppSettings) {
    let dir = app_data_dir();
    let _ = fs::create_dir_all(&dir);
    harden_dir_permissions(&dir);
    if let Ok(raw) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(app_settings_path(), raw);
    }
}

#[derive(serde::Serialize)]
struct LogSettings {
    transcript_logging_enabled: bool,
    log_dir: String,
    retention_days: u64,
}

#[tauri::command]
fn get_log_settings() -> LogSettings {
    LogSettings {
        transcript_logging_enabled: TRANSCRIPT_LOGGING.load(Ordering::Relaxed),
        log_dir: controller_logs_dir().to_string_lossy().into_owned(),
        retention_days: TRANSCRIPT_RETENTION_DAYS,
    }
}

#[tauri::command]
fn set_transcript_logging(enabled: bool) -> Result<(), String> {
    TRANSCRIPT_LOGGING.store(enabled, Ordering::Relaxed);
    save_app_settings(&AppSettings {
        transcript_logging_enabled: enabled,
    });
    Ok(())
}

#[tauri::command]
fn reveal_log_dir() -> Result<(), String> {
    let dir = controller_logs_dir();
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open log folder: {e}"))
}

#[cfg(target_os = "windows")]
struct PuttyWindowSearch {
    target_pid: u32,
    found: Option<HWND>,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_putty_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam as *mut PuttyWindowSearch);
    let mut class_name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, class_name.as_mut_ptr(), class_name.len() as i32) };
    if len <= 0 {
        return TRUE;
    }

    let class_name = String::from_utf16_lossy(&class_name[..len as usize]);
    if class_name != "PuTTY" {
        return TRUE;
    }

    let mut window_pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut window_pid);
    }
    if window_pid != search.target_pid {
        return TRUE;
    }

    search.found = Some(hwnd);
    FALSE
}

#[cfg(target_os = "windows")]
fn find_putty_window(pid: u32) -> Option<HWND> {
    // Commands may change controller hardware state. Only target the PuTTY
    // process launched for this session; another open PuTTY window is never a
    // safe fallback while this terminal is still starting or has already closed.
    let mut search = PuttyWindowSearch {
        target_pid: pid,
        found: None,
    };
    unsafe {
        EnumWindows(
            Some(enum_putty_windows),
            &mut search as *mut PuttyWindowSearch as LPARAM,
        );
    }
    search.found
}

#[cfg(target_os = "windows")]
fn send_text_to_putty_window(
    pid: u32,
    _device: Option<&str>,
    text: &str,
) -> Result<(), String> {
    // On a controller's first connection, PuTTY displays its host-key Security
    // Alert before it creates the terminal window. Keep looking long enough for
    // the technician to accept that prompt instead of failing the diagnostic
    // command after the old two-second window.
    const PUTTY_WINDOW_RETRIES: u32 = 300;
    let hwnd = (0..PUTTY_WINDOW_RETRIES)
        .find_map(|attempt| {
            let found = find_putty_window(pid);
            if found.is_none() && attempt + 1 < PUTTY_WINDOW_RETRIES {
                thread::sleep(Duration::from_millis(100));
            }
            found
        })
        .ok_or_else(|| {
            "PuTTY's terminal window was not ready. If a PuTTY Security Alert is open, accept it and try the command again.".to_string()
        })?;

    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let payload = if normalized.is_empty() {
        "\r".to_string()
    } else {
        normalized
            .split('\n')
            .map(|line| format!("{line}\r"))
            .collect::<Vec<_>>()
            .join("")
    };

    for unit in payload.encode_utf16() {
        let ok = unsafe { PostMessageW(hwnd, WM_CHAR, unit as WPARAM, 0) };
        if ok == 0 {
            return Err("Failed to send command to PuTTY.".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn find_putty_executable() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("putty.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    [
        PathBuf::from(r"C:\Program Files\PuTTY\putty.exe"),
        PathBuf::from(r"C:\Program Files (x86)\PuTTY\putty.exe"),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join(r"Programs\PuTTY\putty.exe"))
            .unwrap_or_default(),
    ]
    .into_iter()
    .find(|path| !path.as_os_str().is_empty() && path.exists())
}

#[cfg(target_os = "windows")]
fn append_ssh_string(out: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
    let len = u32::try_from(value.len()).map_err(|_| "SSH key component is too large".to_string())?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

#[cfg(target_os = "windows")]
fn append_ssh_mpint(out: &mut Vec<u8>, value: &Mpint) -> Result<(), String> {
    append_ssh_string(out, value.as_bytes())
}

#[cfg(target_os = "windows")]
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized_key = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        normalized_key[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; BLOCK_SIZE];
    let mut outer_pad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        inner_pad[i] ^= normalized_key[i];
        outer_pad[i] ^= normalized_key[i];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

#[cfg(target_os = "windows")]
fn ppk_base64_lines(bytes: &[u8]) -> Vec<String> {
    let encoded = BASE64_STANDARD.encode(bytes);
    encoded
        .as_bytes()
        .chunks(64)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}

/// Convert the bundle's passphraseless OpenSSH RSA key to an unencrypted PPK
/// v3 file in-process. Windows PuTTYgen is a GUI application and does not
/// support the Unix `-O private -o ...` conversion syntax; attempting it opens
/// the modal "unrecognised option '-O'" error seen by technicians.
#[cfg(target_os = "windows")]
fn ensure_station_ppk() -> Result<PathBuf, String> {
    let station = home_ssh_dir().join("station");
    if !station.exists() {
        return Err("SSH key not found at ~/.ssh/station. Load the VPN bundle once to install it.".into());
    }
    let ppk = home_ssh_dir().join("station.ppk");

    let ppk_looks_valid = fs::read_to_string(&ppk)
        .map(|contents| contents.starts_with("PuTTY-User-Key-File-3: "))
        .unwrap_or(false);
    let up_to_date = match (fs::metadata(&ppk), fs::metadata(&station)) {
        (Ok(p), Ok(s)) => match (p.modified(), s.modified()) {
            (Ok(pm), Ok(sm)) => pm >= sm,
            _ => true,
        },
        _ => false,
    };
    if ppk_looks_valid && up_to_date {
        return Ok(ppk);
    }

    let key_text = fs::read_to_string(&station)
        .map_err(|e| format!("Could not read ~/.ssh/station: {e}"))?;
    let (rsa, comment) = if key_text.contains("-----BEGIN RSA PRIVATE KEY-----") {
        let pkcs1 = rsa::RsaPrivateKey::from_pkcs1_pem(&key_text)
            .map_err(|e| format!("Could not read the bundle's PKCS#1 RSA station key: {e}"))?;
        let keypair = ssh_key::private::RsaKeypair::try_from(&pkcs1)
            .map_err(|e| format!("Could not convert the bundle's RSA station key: {e}"))?;
        (keypair, "FWDS station key".to_string())
    } else {
        let private_key = PrivateKey::from_openssh(&key_text)
            .map_err(|e| format!("Could not read ~/.ssh/station as an OpenSSH private key: {e}"))?;
        if private_key.is_encrypted() {
            return Err("The station SSH key is passphrase-protected; automatic PuTTY conversion requires the bundle's passphraseless station key.".into());
        }
        let keypair = private_key
            .key_data()
            .rsa()
            .cloned()
            .ok_or_else(|| "The station SSH key is not RSA, so this PuTTY conversion cannot use it.".to_string())?;
        let comment = private_key.comment().replace(['\r', '\n'], " ");
        let comment = if comment.trim().is_empty() {
            "FWDS station key".to_string()
        } else {
            comment
        };
        (keypair, comment)
    };

    let mut public_blob = Vec::new();
    append_ssh_string(&mut public_blob, b"ssh-rsa")?;
    append_ssh_mpint(&mut public_blob, &rsa.public.e)?;
    append_ssh_mpint(&mut public_blob, &rsa.public.n)?;
    let mut private_blob = Vec::new();
    append_ssh_mpint(&mut private_blob, &rsa.private.d)?;
    append_ssh_mpint(&mut private_blob, &rsa.private.p)?;
    append_ssh_mpint(&mut private_blob, &rsa.private.q)?;
    append_ssh_mpint(&mut private_blob, &rsa.private.iqmp)?;

    let mut mac_data = Vec::new();
    append_ssh_string(&mut mac_data, b"ssh-rsa")?;
    append_ssh_string(&mut mac_data, b"none")?;
    append_ssh_string(&mut mac_data, comment.as_bytes())?;
    append_ssh_string(&mut mac_data, &public_blob)?;
    append_ssh_string(&mut mac_data, &private_blob)?;
    let mac = hmac_sha256(&[], &mac_data);

    let public_lines = ppk_base64_lines(&public_blob);
    let private_lines = ppk_base64_lines(&private_blob);
    let mut output = format!(
        "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nComment: {comment}\nPublic-Lines: {}\n",
        public_lines.len()
    );
    for line in public_lines {
        output.push_str(&line);
        output.push('\n');
    }
    output.push_str(&format!("Private-Lines: {}\n", private_lines.len()));
    for line in private_lines {
        output.push_str(&line);
        output.push('\n');
    }
    output.push_str("Private-MAC: ");
    for byte in mac {
        output.push_str(&format!("{byte:02x}"));
    }
    output.push('\n');

    fs::write(&ppk, output).map_err(|e| format!("Could not write {}: {e}", ppk.display()))?;
    harden_windows_key_acl(&ppk);
    Ok(ppk)
}

#[cfg(target_os = "windows")]
fn launch_windows_putty_ssh(host: &str, mode: &str, state: &AppState) -> Result<(), String> {
    let putty_path = find_putty_executable()
        .ok_or_else(|| "PuTTY not found. Install PuTTY from putty.org and try again.".to_string())?;
    let ppk = ensure_station_ppk()?;
    let log_path = if mode == "local" {
        local_serial_log_file(host)
    } else {
        log_file_path(host)
    };

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        kill_shell(&mut inner);
        if let Some(mut child) = inner.windows_local_terminal_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.connection_mode = mode.to_string();
        inner.local_serial_device = (mode == "local").then(|| host.to_string());
        inner.controller_ip = (mode == "vpn").then(|| host.to_string());
        inner.shell_logs.clear();
        inner.shell_log_cursor = 0;
        inner.shell_phase = "connecting".into();
        inner.shell_detail = format!("Opening PuTTY for root@{host}...");
        inner.shell_logs.push(format!("[PuTTY opening] root@{host}"));
    }

    append_transcript(
        &log_path,
        &format!(
            "\n===== {mode} putty session start ({}) =====\ncontroller: {host}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        ),
    );

    let ppk_str = ppk.to_string_lossy();
    let log_str = log_path.to_string_lossy();
    let child = Command::new(&putty_path)
        .args([
            "-ssh",
            host,
            "-l",
            "root",
            "-i",
            ppk_str.as_ref(),
            "-sessionlog",
            log_str.as_ref(),
            "-logoverwrite",
        ])
        .spawn()
        .map_err(|e| format!("Failed to open PuTTY: {e}"))?;
    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.windows_local_terminal_child = Some(child);
        inner.shell_detail = format!("PuTTY opened for root@{host}; waiting for controller shell...");
        inner.shell_logs.push(format!("[PuTTY opened] root@{host}"));
    }
    start_log_watcher_internal(state, true)?;

    // Do not block Connect while waiting for PuTTY's first-use host-key dialog.
    // Command sends use the longer retry path in send_text_to_putty_window.
    Ok(())
}

/// Restrict generated key files to the current Windows user. Best-effort
/// equivalent of the `chmod 0600` used on Unix.
#[cfg(target_os = "windows")]
fn harden_windows_key_acl(path: &Path) {
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        return;
    }
    let path_str = path.to_string_lossy();
    let grant = format!("{user}:F");
    let _ = Command::new("icacls")
        .args([
            path_str.as_ref(),
            "/inheritance:r",
            "/grant:r",
            grant.as_str(),
        ])
        .output();
}

#[cfg(target_os = "windows")]
fn sync_windows_terminal_child(inner: &mut InnerState) {
    let Some(mut child) = inner.windows_local_terminal_child.take() else {
        return;
    };

    match child.try_wait() {
        Ok(Some(_)) => {
            inner.shell_wizard_input = false;
            inner.shell_wizard_needs_clear = false;
            inner.shell_suppress_redraw = false;
            inner.external_terminal_window_id = None;
            if matches!(inner.shell_phase.as_str(), "connecting" | "connected") {
                inner.shell_phase = "disconnected".into();
                inner.shell_detail = if inner.connection_mode == "local" {
                    "Local session closed".into()
                } else {
                    "PuTTY window closed".into()
                };
                inner.shell_logs.push("[Connection closed]".into());
            }
        }
        Ok(None) | Err(_) => {
            inner.windows_local_terminal_child = Some(child);
        }
    }
}

#[cfg(target_os = "windows")]
fn sync_windows_putty_shell_phase(inner: &mut InnerState) {
    if !matches!(inner.shell_phase.as_str(), "connecting" | "connected") {
        return;
    }
    let (target, log_path) = if inner.connection_mode == "vpn" {
        let Some(ip) = inner.controller_ip.clone() else {
            return;
        };
        (ip.clone(), log_file_path(&ip))
    } else {
        let Some(host) = inner.local_serial_device.clone() else {
            return;
        };
        (host.clone(), local_serial_log_file(&host))
    };
    let Ok(raw) = fs::read_to_string(log_path) else {
        return;
    };

    if inner.shell_phase == "connecting" && vpn_session_has_shell_ready(&raw) {
        inner.shell_phase = "connected".into();
        inner.shell_detail = format!("Controller shell ready in PuTTY ({target})");
        return;
    }

    if let Some(reason) = vpn_session_disconnect_reason(&raw) {
        inner.shell_phase = "failed".into();
        inner.shell_detail = reason;
    }
}

#[cfg(not(target_os = "windows"))]
fn terminal_window_exists(window_id: i64) -> bool {
    let script = format!(
        "tell application \"Terminal\"\nreturn exists window id {window_id}\nend tell"
    );
    Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn close_terminal_window(window_id: i64) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\nif exists window id {window_id} then close window id {window_id} saving no\nend tell"
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to close Terminal window: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Failed to close Terminal window.".into()
        } else {
            format!("Failed to close Terminal window: {stderr}")
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_macos_terminal_shell_phase(inner: &mut InnerState) {
    let Some(window_id) = inner.external_terminal_window_id else {
        return;
    };

    if !terminal_window_exists(window_id) {
        inner.external_terminal_window_id = None;
        inner.shell_wizard_input = false;
        inner.shell_wizard_needs_clear = false;
        inner.shell_suppress_redraw = false;
        if matches!(inner.shell_phase.as_str(), "connecting" | "connected") {
            inner.shell_phase = "disconnected".into();
            inner.shell_detail = if inner.connection_mode == "local" {
                "Local session closed".into()
            } else {
                "Terminal window closed".into()
            };
            inner.shell_logs.push("[Connection closed]".into());
        }
        return;
    }

    if inner.connection_mode != "vpn"
        || !matches!(inner.shell_phase.as_str(), "connecting" | "connected")
    {
        return;
    }

    let Some(ip) = inner.controller_ip.clone() else {
        return;
    };
    let log_path = log_file_path(&ip);
    let Ok(raw) = fs::read_to_string(log_path) else {
        return;
    };

    if inner.shell_phase == "connecting" && vpn_session_has_shell_ready(&raw) {
        inner.shell_phase = "connected".into();
        inner.shell_detail = format!("Controller shell ready in Terminal ({ip})");
        return;
    }

    if let Some(reason) = vpn_session_disconnect_reason(&raw) {
        inner.shell_phase = "failed".into();
        inner.shell_detail = reason;
    }
}

fn latest_vpn_session_text<'a>(raw: &'a str) -> &'a str {
    let start = [
        "===== vpn terminal session start",
        "===== vpn putty session start",
        "===== vpn ssh session start",
    ]
    .iter()
    .filter_map(|marker| raw.rfind(marker))
    .max()
    .unwrap_or(0);
    &raw[start..]
}

fn vpn_session_tail(raw: &str, max_chars: usize) -> String {
    let session = latest_vpn_session_text(raw);
    let chars: Vec<char> = session.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn vpn_session_has_shell_ready(raw: &str) -> bool {
    let session = latest_vpn_session_text(raw);
    session.contains("Frontline Wildfire Defense Systems (FWDS) Controller")
        || session.contains("Type help for a summary of controller commands.")
        || session.contains("]#")
        || session.contains("# ")
}

fn vpn_session_disconnect_reason(raw: &str) -> Option<String> {
    let tail = vpn_session_tail(raw, 6000).to_ascii_lowercase();
    let markers = [
        ("connection timed out", "Connection timed out"),
        ("connection reset by peer", "Connection reset by peer"),
        ("broken pipe", "Broken pipe"),
        ("closed by remote host", "Connection closed by remote host"),
        ("could not resolve hostname", "Could not resolve hostname"),
        ("permission denied", "Permission denied"),
        ("no route to host", "No route to host"),
        ("host is unreachable", "Host is unreachable"),
        ("connection refused", "Connection refused"),
        ("saving session...", "Controller session ended"),
    ];
    for (needle, label) in markers {
        if tail.contains(needle) {
            return Some(label.to_string());
        }
    }
    if tail.contains("connection to ") && tail.contains(" closed") {
        return Some("Connection closed".into());
    }
    None
}

#[cfg(target_os = "windows")]
fn normalize_windows_com_label(raw: &str) -> String {
    let trimmed = raw.trim();
    let upper = trimmed.to_uppercase();
    if upper.starts_with("COM") {
        let digits: String = upper
            .chars()
            .skip(3)
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return format!("COM{digits}");
        }
    }
    trimmed.to_string()
}

#[cfg(target_os = "windows")]
fn describe_windows_port(port_type: &SerialPortType) -> String {
    match port_type {
        SerialPortType::UsbPort(info) => {
            let product = info.product.clone().unwrap_or_else(|| "USB Serial".into());
            let manufacturer = info.manufacturer.clone().unwrap_or_default();
            if manufacturer.is_empty() {
                format!("{product} (VID {:04X}:PID {:04X})", info.vid, info.pid)
            } else {
                format!(
                    "{product} ({manufacturer}, VID {:04X}:PID {:04X})",
                    info.vid, info.pid
                )
            }
        }
        SerialPortType::BluetoothPort => "Bluetooth Serial".into(),
        SerialPortType::PciPort => "PCI Serial".into(),
        SerialPortType::Unknown => "Serial Device".into(),
    }
}

#[cfg(target_os = "windows")]
fn map_serial_open_error(err: &serialport::Error) -> String {
    match err.kind() {
        serialport::ErrorKind::Io(kind) => match kind {
            IoErrorKind::PermissionDenied => "Serial port access denied (check permissions)".into(),
            IoErrorKind::NotFound => "Serial device not found or disconnected".into(),
            IoErrorKind::AlreadyExists | IoErrorKind::AddrInUse => {
                "Serial port is busy (already in use)".into()
            }
            _ => format!("Failed to open serial port: {err}"),
        },
        _ => {
            let lower = err.to_string().to_lowercase();
            if lower.contains("access is denied") {
                "Serial port access denied (check permissions)".into()
            } else if lower.contains("busy") {
                "Serial port is busy (already in use)".into()
            } else if lower.contains("not found") {
                "Serial device not found or disconnected".into()
            } else {
                format!("Failed to open serial port: {err}")
            }
        }
    }
}

fn diagnostic_store_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".fwds-diagnostics-store.json")
}

fn load_diagnostic_store() -> DiagnosticStore {
    let path = diagnostic_store_path();
    let Ok(raw) = fs::read_to_string(path) else {
        return DiagnosticStore::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_diagnostic_store(store: &DiagnosticStore) {
    let path = diagnostic_store_path();
    if let Ok(raw) = serde_json::to_string_pretty(store) {
        let _ = fs::write(path, raw);
    }
}

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
    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if !can_start_from(inner.vpn_phase.as_str()) {
            match inner.vpn_phase.as_str() {
                "connected" => {
                    push_vpn_log(&mut inner, "Start requested while connected; no-op".into());
                    return Ok(());
                }
                "starting" => {
                    push_vpn_log(
                        &mut inner,
                        "Start requested while starting; coalesced".into(),
                    );
                    return Ok(());
                }
                "stopping" => {
                    push_vpn_log(&mut inner, "Start requested while stopping; ignored".into());
                    return Ok(());
                }
                _ => {}
            }
        }
        if inner.vpn_transition_in_flight {
            push_vpn_log(
                &mut inner,
                "Start requested during in-flight transition; coalesced".into(),
            );
            return Ok(());
        }
        inner.vpn_transition_in_flight = true;
        inner.vpn_transition_token = inner.vpn_transition_token.wrapping_add(1);
        inner.vpn_cancel_requested = false;
        inner.vpn_phase = "starting".into();
        inner.vpn_detail = "OpenVPN startup requested".into();
        inner.vpn_logs.clear();
        push_vpn_log(&mut inner, "Starting OpenVPN transition".into());
    }

    let inner_state = state.inner.clone();
    thread::spawn(move || run_vpn_start_transition(inner_state, folder));
    Ok(())
}

/// Stop the managed OpenVPN process (elevated kill via osascript).
#[tauri::command]
fn stop_vpn(state: State<'_, AppState>) -> Result<(), String> {
    let mut should_spawn = false;
    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if !can_stop_from(inner.vpn_phase.as_str()) {
            match inner.vpn_phase.as_str() {
                "disconnected" | "failed" => {
                    push_vpn_log(
                        &mut inner,
                        "Stop requested while disconnected/failed; no-op".into(),
                    );
                    inner.vpn_phase = "disconnected".into();
                    inner.vpn_detail = "OpenVPN already stopped".into();
                    return Ok(());
                }
                "stopping" => {
                    push_vpn_log(
                        &mut inner,
                        "Stop requested while stopping; coalesced".into(),
                    );
                    return Ok(());
                }
                "starting" => {
                    inner.vpn_cancel_requested = true;
                    inner.vpn_phase = "stopping".into();
                    inner.vpn_detail = "Cancelling startup and stopping OpenVPN…".into();
                    push_vpn_log(
                        &mut inner,
                        "Stop requested during startup; cancellation queued".into(),
                    );
                    return Ok(());
                }
                _ => {}
            }
        }
        if !inner.vpn_transition_in_flight {
            inner.vpn_transition_in_flight = true;
            inner.vpn_transition_token = inner.vpn_transition_token.wrapping_add(1);
            should_spawn = true;
        }
        inner.vpn_phase = "stopping".into();
        inner.vpn_detail = "Stopping OpenVPN…".into();
        inner.vpn_cancel_requested = true;
        push_vpn_log(&mut inner, "Stopping OpenVPN transition".into());
    }

    if should_spawn {
        let inner_state = state.inner.clone();
        thread::spawn(move || run_vpn_stop_transition(inner_state));
    }
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
        inner.connection_mode = "vpn".into();
    }

    let station_key = home_ssh_dir().join("station");
    if !station_key.exists() {
        return Err(
            "SSH key not found at ~/.ssh/station. Select and start VPN bundle first.".into(),
        );
    }

    // Spawn SSH directly — no connect.bin, no verbose flags, and a fresh host-key
    // check for each controller. -tt forces a PTY so prompts work and echo behaves
    // like a normal terminal session.
    // avoids host-key conflicts when controllers are replaced.
    let mut child = Command::new("ssh")
        .args([
            "-tt",
            "-i",
            &station_key.to_string_lossy(),
            "-o",
            "LogLevel=ERROR",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "KexAlgorithms=ecdh-sha2-nistp521",
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
    let transcript_path = log_file_path(&ip);
    append_transcript(
        &transcript_path,
        &format!(
            "\n===== vpn ssh session start ({}) =====\ncontroller: {ip}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        ),
    );

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.shell_stdin = stdin;
        inner.shell_child = Some(child);
    }

    let arc = state.inner.clone();
    let diag_arc = state.diagnostic_state.clone();
    let store_arc = state.diagnostic_store.clone();
    let key_arc = state.current_controller_key.clone();
    let app_handle_arc = state.app_handle.clone();
    if let Ok(mut key) = state.current_controller_key.lock() {
        *key = Some(format!("vpn:{ip}"));
    }

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
        let transcript_path = transcript_path.clone();
        let diag_arc = diag_arc.clone();
        let store_arc = store_arc.clone();
        let key_arc = key_arc.clone();
        let app_handle_arc = app_handle_arc.clone();
        let mut diag_buffer = String::new();
        let mut active_controller_key = format!("vpn:{ip}");
        let mut prev_sid: Option<String> = None;
        let mut prev_system_sig = String::new();
        thread::spawn(move || {
            // Raw reader sub-thread sends Option<Vec<u8>>: Some(bytes) | None (EOF)
            let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) => {
                            let _ = tx.send(None);
                            break;
                        }
                        Ok(n) => {
                            let _ = tx.send(Some(buf[..n].to_vec()));
                        }
                        Err(_) => {
                            let _ = tx.send(None);
                            break;
                        }
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
                        append_transcript(&transcript_path, &chunk);
                        diag_buffer.push_str(&chunk);
                        ingest_diagnostic_buffer(
                            &diag_buffer,
                            &diag_arc,
                            &store_arc,
                            &key_arc,
                            &app_handle_arc,
                            &mut active_controller_key,
                            &mut prev_sid,
                            &mut prev_system_sig,
                        );

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
                            if line.is_empty() {
                                continue;
                            }

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
                                if fragment.is_empty() {
                                    p
                                } else {
                                    format!("{}{}", p, fragment)
                                }
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
            append_transcript(
                &transcript_path,
                &format!(
                    "\n===== vpn ssh session end ({}) =====\n",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                ),
            );
        });
    }

    // Stderr reader — with LogLevel=ERROR only real errors appear here.
    if let Some(stderr) = stderr {
        let arc2 = arc.clone();
        let transcript_path = transcript_path.clone();
        let diag_arc = diag_arc.clone();
        let store_arc = store_arc.clone();
        let key_arc = key_arc.clone();
        let app_handle_arc = app_handle_arc.clone();
        let mut diag_buffer = String::new();
        let mut active_controller_key = format!("vpn:{ip}");
        let mut prev_sid: Option<String> = None;
        let mut prev_system_sig = String::new();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                append_transcript(&transcript_path, &format!("[ssh] {line}\n"));
                diag_buffer.push_str(&line);
                diag_buffer.push('\n');
                ingest_diagnostic_buffer(
                    &diag_buffer,
                    &diag_arc,
                    &store_arc,
                    &key_arc,
                    &app_handle_arc,
                    &mut active_controller_key,
                    &mut prev_sid,
                    &mut prev_system_sig,
                );
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
    #[cfg(target_os = "windows")]
    {
        sync_windows_terminal_child(&mut inner);
        sync_windows_putty_shell_phase(&mut inner);
    }
    #[cfg(not(target_os = "windows"))]
    {
        sync_macos_terminal_shell_phase(&mut inner);
    }
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
    if inner.connection_mode == "local" {
        if let Some(writer) = inner.windows_local_serial_writer.as_ref() {
            let mut writer = writer.lock().map_err(|_| "serial lock poisoned")?;
            writer
                .write_all(b"\x03")
                .map_err(|e| format!("Failed to send interrupt: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("Failed to flush interrupt: {e}"))?;
            return Ok(());
        }
    }
    let Some(stdin) = inner.shell_stdin.as_mut() else {
        return Err("Session not open".into());
    };
    stdin
        .write_all(b"\x03")
        .map_err(|e| format!("Failed to send interrupt: {e}"))?;
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
        stdin
            .write_all(b"\x01\x0b")
            .map_err(|e| format!("Failed to clear prefill: {e}"))?;
    }
    stdin
        .write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write to shell: {e}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {e}"))?;
    stdin.flush().map_err(|e| format!("Failed to flush: {e}"))?;
    Ok(())
}

/// Disconnect the active controller shell.
#[tauri::command]
fn disconnect_controller(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let log_path = {
        let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if inner.connection_mode == "vpn" {
            inner.controller_ip.clone().map(|ip| log_file_path(&ip))
        } else {
            None
        }
    };

    #[cfg(not(target_os = "windows"))]
    let (log_path, window_id) = {
        let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        (
            inner.controller_ip.clone().map(|ip| log_file_path(&ip)),
            inner.external_terminal_window_id,
        )
    };

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        kill_shell(&mut inner);
        inner.shell_detail = "Controller disconnected".into();
        inner.controller_ip = None;
        inner.shell_logs.push("[Disconnected]".into());
    }

    #[cfg(target_os = "windows")]
    if let Some(path) = log_path {
        append_transcript(
            &path,
            &format!(
                "\n===== vpn ssh session end ({}) =====\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ),
        );
        stop_log_watcher_internal(&state)?;
        if let Ok(mut diag) = state.diagnostic_state.lock() {
            *diag = DiagnosticState::default();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(window_id) = window_id {
            let _ = close_terminal_window(window_id);
        }
        if let Some(path) = log_path {
            append_transcript(
                &path,
                &format!(
                    "\n===== vpn terminal session end ({}) =====\n",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                ),
            );
        }
        stop_log_watcher_internal(&state)?;
        if let Ok(mut diag) = state.diagnostic_state.lock() {
            *diag = DiagnosticState::default();
        }
    }

    Ok(())
}

/// Ping the target IP and check port 22 reachability for pre-flight diagnostics.
#[tauri::command]
fn run_preflight(ip: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    let ping_ok = Command::new("ping")
        .args(["-n", "1", "-w", "1000", &ip])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    #[cfg(not(target_os = "windows"))]
    let ping_ok = Command::new("ping")
        .args(["-c", "1", "-W", "1000", &ip])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let port_ok = format!("{ip}:22")
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .map(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok())
        .unwrap_or(false);

    let detail = match (ping_ok, port_ok) {
        (true, true) => format!("{ip} reachable, port 22 open"),
        (true, false) => format!("{ip} reachable but port 22 closed"),
        (false, true) => format!("{ip} ping blocked or failed, but port 22 is open"),
        (false, false) => format!("{ip} unreachable"),
    };

    Ok(serde_json::json!({
        "ping_ok": ping_ok,
        "port_ok": port_ok,
        "detail": detail,
    }))
}

/// The install status of one external tool a connection method depends on.
/// Surfaced to the UI so a missing tool can be flagged *before* a connection is
/// attempted, instead of failing silently inside a terminal window that just
/// opens and closes.
#[derive(serde::Serialize)]
struct DependencyStatus {
    /// Stable identifier (`minicom`, `ssh`, `openvpn`, `putty`).
    id: String,
    /// Human label shown in the UI.
    label: String,
    /// Which connection method needs it: `serial`, `network`, or `vpn`.
    method: String,
    /// Whether we could locate the tool on this machine.
    installed: bool,
    /// One-line, copy-pasteable install instruction (empty if none applies).
    install_hint: String,
    /// Where we found it, when installed (handy for support/tooltips).
    found_path: Option<String>,
}

/// Report whether the external tools each connection method needs are installed.
/// Platform-aware and cheap (path probes + `which`/`where`), so the Connect page
/// can call it on load and warn up front. Pairs with the launch-time preflights
/// in `open_local_serial_terminal` / `open_*_terminal` / `resolve_openvpn`, which
/// remain the hard guarantee — this is the friendly heads-up before the click.
#[tauri::command]
fn check_dependencies() -> Vec<DependencyStatus> {
    #[cfg(target_os = "windows")]
    {
        let putty = find_putty_executable();
        let putty_installed = putty.is_some();
        let openvpn = resolve_openvpn().ok();
        vec![
            DependencyStatus {
                id: "putty".into(),
                label: "PuTTY".into(),
                method: "serial".into(),
                installed: putty_installed,
                install_hint: "Install PuTTY from putty.org".into(),
                found_path: putty.as_ref().map(|p| p.display().to_string()),
            },
            DependencyStatus {
                id: "putty-network".into(),
                label: "PuTTY".into(),
                method: "network".into(),
                installed: putty_installed,
                install_hint: "Install PuTTY from putty.org".into(),
                found_path: putty.as_ref().map(|p| p.display().to_string()),
            },
            DependencyStatus {
                id: "openvpn".into(),
                label: "OpenVPN".into(),
                method: "vpn".into(),
                installed: openvpn.is_some(),
                install_hint: "Install OpenVPN Community or OpenVPN Connect".into(),
                found_path: openvpn.map(|p| p.display().to_string()),
            },
        ]
    }

    #[cfg(not(target_os = "windows"))]
    {
        let minicom = resolve_unix_command("minicom");
        let ssh = resolve_unix_command("ssh");
        let openvpn = resolve_openvpn().ok();
        vec![
            DependencyStatus {
                id: "minicom".into(),
                label: "minicom".into(),
                method: "serial".into(),
                installed: minicom.is_some(),
                install_hint: "brew install minicom".into(),
                found_path: minicom.map(|p| p.display().to_string()),
            },
            DependencyStatus {
                id: "ssh".into(),
                label: "OpenSSH (ssh)".into(),
                method: "network".into(),
                installed: ssh.is_some(),
                install_hint: "Install the OpenSSH client".into(),
                found_path: ssh.map(|p| p.display().to_string()),
            },
            DependencyStatus {
                id: "openvpn".into(),
                label: "OpenVPN".into(),
                method: "vpn".into(),
                installed: openvpn.is_some(),
                install_hint: "brew install openvpn".into(),
                found_path: openvpn.map(|p| p.display().to_string()),
            },
        ]
    }
}

/// Open the active controller connection in Terminal.app for full interactive setup.
/// SSH session is wrapped with `script` and logged to the app's controller log path
/// so the diagnostics watcher tails the same visible Terminal session.
#[tauri::command]
fn open_controller_terminal(state: State<'_, AppState>, ip: Option<String>) -> Result<(), String> {
    let ip = {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.connection_mode = "vpn".into();
        inner.local_serial_device = None;
        if let Some(ip) = ip {
            inner.controller_ip = Some(ip);
        }
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

    #[cfg(target_os = "windows")]
    {
        return launch_windows_putty_ssh(&ip, "vpn", &state);

    }

    #[cfg(not(target_os = "windows"))]
    {
        // Preflight: the session runs `ssh` inside Terminal. This ships with
        // macOS so it's rarely missing, but if it were, the window would flash
        // "command not found" and close with no explanation.
        require_unix_command(
            "ssh",
            "OpenSSH (ssh) was not found, so the controller session can't open. \
             Install or restore the OpenSSH client and try again.",
        )?;

        let previous_window_id = {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            let previous_window_id = inner.external_terminal_window_id.take();
            kill_shell(&mut inner);
            inner.connection_mode = "vpn".into();
            inner.local_serial_device = None;
            inner.controller_ip = Some(ip.clone());
            inner.shell_logs.clear();
            inner.shell_log_cursor = 0;
            inner.shell_phase = "connecting".into();
            inner.shell_detail = format!("Opening Terminal SSH session to root@{ip}...");
            inner
                .shell_logs
                .push(format!("[Terminal opening] root@{ip}"));
            previous_window_id
        };
        if let Some(window_id) = previous_window_id {
            let _ = close_terminal_window(window_id);
        }

        let log_path = log_file_path(&ip);
        append_transcript(
            &log_path,
            &format!(
                "\n===== vpn terminal session start ({}) =====\ncontroller: {ip}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ),
        );
        let ssh_cmd = format!(
            "ssh -tt -i {} -o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o KexAlgorithms=ecdh-sha2-nistp521 {}",
            shell_quote(&station_key.to_string_lossy()),
            shell_quote(&format!("root@{ip}")),
        );
        let command = format!(
            "clear; script -qF {} {}; exit",
            shell_quote(&log_path.to_string_lossy()),
            &ssh_cmd,
        );
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script {}\ndelay 0.1\nreturn id of front window\nend tell",
            applescript_string_literal(&command)
        );

        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to open Terminal: {e}"))?;

        if out.status.success() {
            let window_id = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<i64>()
                .ok();
            if let Ok(mut inner) = state.inner.lock() {
                inner.external_terminal_window_id = window_id;
                inner.shell_phase = "connecting".into();
                inner.shell_detail = format!("Terminal opened for root@{ip}; waiting for controller shell...");
                inner
                    .shell_logs
                    .push(format!("[Terminal opened] root@{ip}"));
            }
            start_log_watcher_internal(&state, true)?;
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let message = if stderr.is_empty() {
                "Terminal launch failed.".into()
            } else {
                format!("Failed to open Terminal: {stderr}")
            };
            if let Ok(mut inner) = state.inner.lock() {
                inner.shell_phase = "failed".into();
                inner.shell_detail = message.clone();
            }
            Err(message)
        }
    }
}

#[tauri::command]
fn list_serial_devices() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut devices: Vec<String> = serialport::available_ports()
            .map_err(|e| format!("Failed to enumerate COM ports: {e}"))?
            .into_iter()
            .map(|p| {
                let summary = describe_windows_port(&p.port_type);
                format!("{} — {}", p.port_name, summary)
            })
            .collect();
        devices.sort();
        return Ok(devices);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let entries = fs::read_dir("/dev").map_err(|e| format!("Failed to read /dev: {e}"))?;
        let mut devices = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("cu.") {
                devices.push(format!("/dev/{name}"));
            }
        }
        devices.sort();
        Ok(devices)
    }
}

/// Resolve a command-line tool by name the way the login shell we hand the
/// command to (Terminal) would: check the common install prefixes, then fall
/// back to `which`. Returns the resolved path, or `None` if the tool isn't
/// installed anywhere we can see.
///
/// This exists so we can preflight external dependencies before opening a
/// Terminal window. `osascript` reports success as soon as Terminal launches —
/// it has no idea whether the command we asked it to run (`minicom`, `ssh`, …)
/// actually exists. Without this check a missing tool prints "command not
/// found", the window closes, and the user only sees the generic
/// "terminal window closed" banner. Checking up front lets us return an honest,
/// actionable error instead.
#[cfg(not(target_os = "windows"))]
fn resolve_unix_command(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin"));
    }
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    // Fall back to `which`, in case the tool lives on a PATH entry we didn't
    // enumerate above.
    if let Ok(out) = Command::new("which").arg(name).output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Preflight a required Unix tool. Returns `missing_message` verbatim as the
/// error when the tool can't be found, so callers control the exact,
/// user-facing wording (including the install instructions).
#[cfg(not(target_os = "windows"))]
fn require_unix_command(name: &str, missing_message: &str) -> Result<(), String> {
    if resolve_unix_command(name).is_some() {
        Ok(())
    } else {
        Err(missing_message.to_string())
    }
}

#[tauri::command]
fn open_local_serial_terminal(device: String, state: State<'_, AppState>) -> Result<(), String> {
    if device.trim().is_empty() {
        return Err("Serial device is required".into());
    }

    #[cfg(target_os = "windows")]
    {
        let com_port = normalize_windows_com_label(&device);
        let log_path = local_serial_log_file(&com_port);
        let putty_path = find_putty_executable().ok_or_else(|| {
            "PuTTY not found. Install PuTTY to use local serial on Windows.".to_string()
        })?;

        {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner.connection_mode = "local".into();
            inner.local_serial_device = Some(com_port.clone());
            inner.shell_phase = "connected".into();
            inner.shell_detail = format!("PuTTY opened on {com_port} @ 115200");
            inner.external_terminal_window_id = None;
            if let Some(mut child) = inner.windows_local_terminal_child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(kill) = inner.windows_local_serial_kill.take() {
                kill.store(true, Ordering::Relaxed);
            }
            inner.windows_local_serial_writer = None;
            inner
                .shell_logs
                .push(format!("[PuTTY opening] {com_port} @ 115200"));
            inner.shell_log_cursor = inner.shell_logs.len();
        }

        if TRANSCRIPT_LOGGING.load(Ordering::Relaxed) {
            let mut transcript = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .map_err(|e| format!("Failed to open transcript log: {e}"))?;
            let _ = writeln!(
                transcript,
                "\n===== local serial session start ({}) =====",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            let _ = writeln!(transcript, "device: {com_port} @ 115200");
            let _ = transcript.flush();
        }

        let log_str = log_path.to_string_lossy();
        let mut putty_args: Vec<&str> =
            vec!["-serial", com_port.as_str(), "-sercfg", "115200,8,n,1,N"];
        // Serial transcripts are PuTTY's own -sessionlog file (there is no
        // in-app SSH stream to capture here); gate it on the logging setting.
        if TRANSCRIPT_LOGGING.load(Ordering::Relaxed) {
            putty_args.extend(["-sessionlog", log_str.as_ref(), "-logoverwrite"]);
        }
        let child = Command::new(&putty_path)
            .args(&putty_args)
            .spawn()
            .map_err(|e| format!("Failed to open PuTTY: {e}"))?;

        let putty_pid = child.id();
        {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner.windows_local_terminal_child = Some(child);
            inner
                .shell_logs
                .push(format!("[PuTTY opened] {com_port} @ 115200"));
        }

        let _ = send_text_to_putty_window(putty_pid, Some(&com_port), "");

        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Preflight: the serial console runs `minicom` inside Terminal. If it
        // isn't installed the Terminal window just flashes "command not found"
        // and closes, leaving only the generic "terminal window closed" banner.
        // Fail here instead, with a message the technician can act on.
        require_unix_command(
            "minicom",
            "minicom is not installed, so the serial console can't open. \
             Install it with: brew install minicom",
        )?;

        let previous_window_id = {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            let previous_window_id = inner.external_terminal_window_id.take();
            kill_shell(&mut inner);
            inner.connection_mode = "local".into();
            inner.local_serial_device = Some(device.clone());
            inner.shell_logs.clear();
            inner.shell_log_cursor = 0;
            inner.shell_phase = "connected".into();
            inner.shell_detail = format!("Terminal opened on {device} @ 115200");
            inner
                .shell_logs
                .push(format!("[Terminal opening] {device} @ 115200"));
            previous_window_id
        };
        if let Some(window_id) = previous_window_id {
            let _ = close_terminal_window(window_id);
        }

        let log_path = local_serial_log_file(&device);
        let command = format!(
            "clear; script -qF {} minicom -D {} -b 115200; exit",
            shell_quote(&log_path.to_string_lossy()),
            shell_quote(&device),
        );
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script {}\ndelay 0.1\nreturn id of front window\nend tell",
            applescript_string_literal(&command)
        );

        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to open Terminal: {e}"))?;

        if out.status.success() {
            let window_id = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<i64>()
                .ok();
            if let Ok(mut inner) = state.inner.lock() {
                inner.external_terminal_window_id = window_id;
                inner
                    .shell_logs
                    .push(format!("[Terminal opened] {device} @ 115200"));
            }
            start_log_watcher_internal(&state, true)?;
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let message = if stderr.is_empty() {
                "Terminal launch failed.".into()
            } else {
                format!("Failed to open Terminal: {stderr}")
            };
            if let Ok(mut inner) = state.inner.lock() {
                inner.shell_phase = "failed".into();
                inner.shell_detail = message.clone();
            }
            Err(message)
        }
    }
}

/// Connect to a controller on the local network via SSH — no VPN required.
/// Reuses the bundle's `station` key (already at ~/.ssh/station) for key-based,
/// passwordless auth as root, so there is no root/password prompt.
///
/// `host` may be an mDNS name (`<serial>.local`) or a LAN IP (`192.168.1.x`).
/// Tagged as `connection_mode = "local"` and recorded in `local_serial_device`
/// so the shared local-session UI and `disconnect_local_controller` teardown
/// (which closes the terminal window and writes the session-end marker) apply.
/// Browse mDNS for controllers on the local network. The controller's avahi
/// advertises `_ssh._tcp` with the serial number as the instance name. The
/// in-process browser returns both the serial and resolved address, so Windows
/// does not need Bonjour's `dns-sd.exe` or separate `.local` resolution.
///
/// This is an `async` command whose blocking work (a ~3.5s browse window) is
/// offloaded to `spawn_blocking`. A synchronous command would run on the main
/// thread and freeze the whole UI for the duration of the scan.
#[tauri::command]
async fn discover_controllers() -> Result<Vec<DiscoveredController>, String> {
    tokio::task::spawn_blocking(discover_controllers_blocking)
        .await
        .map_err(|e| format!("Controller scan task failed: {e}"))?
}

#[derive(Clone, serde::Serialize)]
struct DiscoveredController {
    serial: String,
    address: String,
    hostname: String,
}

fn discover_controllers_blocking() -> Result<Vec<DiscoveredController>, String> {
    const SERVICE_TYPE: &str = "_ssh._tcp.local.";
    let mdns = ServiceDaemon::new()
        .map_err(|e| format!("Could not start controller discovery: {e}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("Could not browse for controllers: {e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_millis(3500);
    let mut controllers = Vec::new();

    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(service)) => {
                let serial = service
                    .fullname
                    .strip_suffix(SERVICE_TYPE)
                    .unwrap_or(&service.fullname)
                    .trim_end_matches('.')
                    .to_string();
                if serial.len() != 8 || !serial.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let hostname = service.host.trim_end_matches('.').to_string();
                let addresses: Vec<String> = service
                    .get_addresses_v4()
                    .into_iter()
                    .map(|ip| ip.to_string())
                    .collect();
                let addresses = if addresses.is_empty() {
                    vec![hostname.clone()]
                } else {
                    addresses
                };

                for address in addresses {
                    if !controllers.iter().any(|found: &DiscoveredController| {
                        found.serial == serial && found.address == address
                    }) {
                        controllers.push(DiscoveredController {
                            serial: serial.clone(),
                            address,
                            hostname: hostname.clone(),
                        });
                    }
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let _ = mdns.stop_browse(SERVICE_TYPE);
    let _ = mdns.shutdown();
    let mut selected: HashMap<String, (u8, DiscoveredController)> = HashMap::new();
    for controller in controllers {
        let rank = controller_address_rank(&controller.address);
        selected
            .entry(controller.serial.clone())
            .and_modify(|(selected_rank, selected_controller)| {
                if rank > *selected_rank
                    || (rank == *selected_rank
                        && controller.address < selected_controller.address)
                {
                    *selected_rank = rank;
                    *selected_controller = controller.clone();
                }
            })
            .or_insert((rank, controller));
    }

    let mut controllers: Vec<DiscoveredController> = selected
        .into_values()
        .map(|(_, controller)| controller)
        .collect();
    controllers.sort_by(|a, b| a.serial.cmp(&b.serial));
    Ok(controllers)
}

/// Prefer a reachable direct-Ethernet (link-local) address, then any other
/// reachable address. This collapses one controller advertising the same SID
/// through both Ethernet and the local LAN without choosing a dead route.
fn controller_address_rank(address: &str) -> u8 {
    let Ok(ip) = address.parse::<Ipv4Addr>() else {
        return 0;
    };
    let socket = SocketAddr::new(IpAddr::V4(ip), 22);
    let reachable = TcpStream::connect_timeout(&socket, Duration::from_millis(250)).is_ok();

    match (reachable, ip.is_link_local()) {
        (true, true) => 3,
        (true, false) => 2,
        (false, true) => 1,
        (false, false) => 0,
    }
}

#[tauri::command]
fn open_local_network_terminal(host: String, state: State<'_, AppState>) -> Result<(), String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("Controller address is required (e.g. 45230110.local or 192.168.1.8).".into());
    }

    let station_key = home_ssh_dir().join("station");
    if !station_key.exists() {
        return Err(
            "SSH key not found at ~/.ssh/station. Load the VPN bundle once (Files tab) to install \
             the key — you don't need to start the VPN for local access."
                .into(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        return launch_windows_putty_ssh(&host, "local", &state);

    }

    #[cfg(not(target_os = "windows"))]
    {
        // Preflight: this session runs `ssh` inside Terminal. Ships with macOS,
        // but check anyway so a missing client fails honestly instead of
        // flashing "command not found" and closing the window.
        require_unix_command(
            "ssh",
            "OpenSSH (ssh) was not found, so the controller session can't open. \
             Install or restore the OpenSSH client and try again.",
        )?;

        let previous_window_id = {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            let previous_window_id = inner.external_terminal_window_id.take();
            kill_shell(&mut inner);
            inner.connection_mode = "local".into();
            inner.local_serial_device = Some(host.clone());
            inner.controller_ip = None;
            inner.shell_logs.clear();
            inner.shell_log_cursor = 0;
            inner.shell_phase = "connecting".into();
            inner.shell_detail = format!("Opening Terminal SSH session to root@{host}...");
            inner
                .shell_logs
                .push(format!("[Terminal opening] root@{host}"));
            previous_window_id
        };
        if let Some(window_id) = previous_window_id {
            let _ = close_terminal_window(window_id);
        }

        let log_path = local_serial_log_file(&host);
        append_transcript(
            &log_path,
            &format!(
                "\n===== local network ssh session start ({}) =====\ncontroller: {host}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ),
        );
        // Same passwordless, key-based SSH as the VPN path — only the host differs.
        // UserKnownHostsFile=/dev/null avoids host-key conflicts after firmware
        // updates (the doc's ssh-keygen -R purge is unnecessary here).
        let ssh_cmd = format!(
            "ssh -tt -i {} -o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o KexAlgorithms=ecdh-sha2-nistp521 {}",
            shell_quote(&station_key.to_string_lossy()),
            shell_quote(&format!("root@{host}")),
        );
        let command = format!(
            "clear; script -qF {} {}; exit",
            shell_quote(&log_path.to_string_lossy()),
            &ssh_cmd,
        );
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script {}\ndelay 0.1\nreturn id of front window\nend tell",
            applescript_string_literal(&command)
        );

        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to open Terminal: {e}"))?;

        if out.status.success() {
            let window_id = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<i64>()
                .ok();
            if let Ok(mut inner) = state.inner.lock() {
                inner.external_terminal_window_id = window_id;
                inner.shell_phase = "connecting".into();
                inner.shell_detail =
                    format!("Terminal opened for root@{host}; waiting for controller shell...");
                inner
                    .shell_logs
                    .push(format!("[Terminal opened] root@{host}"));
            }
            start_log_watcher_internal(&state, true)?;
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let message = if stderr.is_empty() {
                "Terminal launch failed.".into()
            } else {
                format!("Failed to open Terminal: {stderr}")
            };
            if let Ok(mut inner) = state.inner.lock() {
                inner.shell_phase = "failed".into();
                inner.shell_detail = message.clone();
            }
            Err(message)
        }
    }
}

#[tauri::command]
fn disconnect_local_controller(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let window_id = {
        let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.external_terminal_window_id
    };

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if let Some(device) = inner.local_serial_device.clone() {
            if TRANSCRIPT_LOGGING.load(Ordering::Relaxed) {
                let log_path = local_serial_log_file(&device);
                if let Ok(mut f) = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_path)
                {
                    let _ = writeln!(
                        f,
                        "\n===== local serial session end ({}) =====",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                    );
                    let _ = f.flush();
                }
            }
        }
        if let Some(kill) = inner.windows_local_serial_kill.take() {
            kill.store(true, Ordering::Relaxed);
        }
        if let Some(mut child) = inner.windows_local_terminal_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.windows_local_serial_writer = None;
        inner.local_serial_device = None;
        inner.connection_mode = "local".into();
        inner.external_terminal_window_id = None;
        inner.shell_phase = "disconnected".into();
        inner.shell_detail = "Local session disconnected".into();
        inner.shell_logs.push("[Local disconnected]".into());
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(window_id) = window_id {
        let _ = close_terminal_window(window_id);
    }
    stop_log_watcher_internal(&state)?;
    if let Ok(mut diag) = state.diagnostic_state.lock() {
        *diag = DiagnosticState::default();
    }
    Ok(())
}

/// Lightweight status for the Session tab — does NOT advance the ConsoleTab cursor.
#[tauri::command]
fn get_controller_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    #[cfg(target_os = "windows")]
    {
        sync_windows_terminal_child(&mut inner);
        sync_windows_putty_shell_phase(&mut inner);
    }
    #[cfg(not(target_os = "windows"))]
    {
        sync_macos_terminal_shell_phase(&mut inner);
    }
    Ok(serde_json::json!({
        "phase": inner.shell_phase,
        "detail": inner.shell_detail,
    }))
}

/// App-wide snapshot for the header status bar.
#[tauri::command]
fn get_app_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    sync_vpn_logs(&mut inner);
    #[cfg(target_os = "windows")]
    {
        sync_windows_terminal_child(&mut inner);
        sync_windows_putty_shell_phase(&mut inner);
    }
    #[cfg(not(target_os = "windows"))]
    {
        sync_macos_terminal_shell_phase(&mut inner);
    }
    Ok(serde_json::json!({
        "vpn_phase": inner.vpn_phase,
        "vpn_detail": inner.vpn_detail,
        "shell_phase": inner.shell_phase,
        "shell_detail": inner.shell_detail,
        "controller_ip": inner.controller_ip,
        "connection_mode": inner.connection_mode,
        "local_serial_device": inner.local_serial_device,
        "external_terminal_window_id": inner.external_terminal_window_id,
    }))
}

/// Send input to the active external Terminal.app session (window/tab launched by this app).
#[tauri::command]
fn send_external_input(text: String, state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        sync_windows_terminal_child(&mut inner);
        if inner.connection_mode == "vpn" {
            let putty_pid = inner
                .windows_local_terminal_child
                .as_ref()
                .map(|child| child.id())
                .ok_or_else(|| "Session not open".to_string())?;
            drop(inner);
            return send_text_to_putty_window(putty_pid, None, &text);
        }

        let (writer_arc, putty_pid, local_device) = {
            if inner.connection_mode != "local" {
                (None, None, None)
            } else {
                (
                    inner.windows_local_serial_writer.clone(),
                    inner
                        .windows_local_terminal_child
                        .as_ref()
                        .map(|child| child.id()),
                    inner.local_serial_device.clone(),
                )
            }
        };
        if let Some(writer_arc) = writer_arc {
            let mut writer = writer_arc.lock().map_err(|_| "serial lock poisoned")?;
            if normalized.is_empty() {
                writer
                    .write_all(b"\r\n")
                    .map_err(|e| format!("Failed to send command: {e}"))?;
            } else {
                for line in normalized.split('\n') {
                    writer
                        .write_all(line.as_bytes())
                        .map_err(|e| format!("Failed to send command: {e}"))?;
                    writer
                        .write_all(b"\r\n")
                        .map_err(|e| format!("Failed to send command: {e}"))?;
                }
            }
            writer
                .flush()
                .map_err(|e| format!("Failed to flush command: {e}"))?;
            return Ok(());
        }

        let putty_pid = putty_pid.ok_or_else(|| "Session not open".to_string())?;
        send_text_to_putty_window(putty_pid, local_device.as_deref(), &text)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let window_id = {
            let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner
                .external_terminal_window_id
                .ok_or_else(|| "Open session first".to_string())?
        };
        if !terminal_window_exists(window_id) {
            return Err("Open session first".into());
        }

        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let script = format!(
            "set payload to {}\n\
set oldDelims to AppleScript's text item delimiters\n\
set AppleScript's text item delimiters to linefeed\n\
set payloadLines to text items of payload\n\
set AppleScript's text item delimiters to oldDelims\n\
tell application \"Terminal\"\n\
if not (exists window id {window_id}) then error \"Open session first\"\n\
activate\n\
set targetWindow to window id {window_id}\n\
set index of targetWindow to 1\n\
set targetTab to selected tab of targetWindow\n\
repeat with lineText in payloadLines\n\
set cmd to contents of lineText\n\
if cmd is not \"\" then\n\
do script cmd in targetTab\n\
end if\n\
end repeat\n\
end tell",
            applescript_string_literal(&normalized)
        );
        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to send command: {e}"))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.contains("Not authorized to send Apple events") {
                return Err("Enable Terminal automation permissions for command send.".into());
            }
            return Err(if stderr.is_empty() {
                "Open session first".into()
            } else {
                format!("Failed to send command: {stderr}")
            });
        }

        Ok(())
    }
}

fn has_any_diag_data(diag: &DiagnosticState) -> bool {
    diag.wifi.is_some()
        || diag.cellular.is_some()
        || diag.satellite.is_some()
        || diag.ethernet.is_some()
        || diag.pressure.is_some()
        || diag.system.is_some()
}

fn merge_non_empty_cards(base: &mut DiagnosticState, incoming: &DiagnosticState) {
    if incoming.wifi.is_some() {
        base.wifi = incoming.wifi.clone();
    }
    if incoming.cellular.is_some() {
        base.cellular = incoming.cellular.clone();
    }
    if incoming.satellite.is_some() {
        base.satellite = incoming.satellite.clone();
    }
    if incoming.ethernet.is_some() {
        base.ethernet = incoming.ethernet.clone();
    }
    if incoming.pressure.is_some() {
        base.pressure = incoming.pressure.clone();
    }
    if incoming.system.is_some() {
        base.system = incoming.system.clone();
    }
    base.last_updated = incoming.last_updated.clone().or(base.last_updated.clone());
}

fn ingest_diagnostic_buffer(
    buffer: &str,
    diag_arc: &Arc<Mutex<DiagnosticState>>,
    store_arc: &Arc<Mutex<DiagnosticStore>>,
    key_arc: &Arc<Mutex<Option<String>>>,
    app_handle_arc: &Arc<Mutex<Option<tauri::AppHandle>>>,
    active_controller_key: &mut String,
    prev_sid: &mut Option<String>,
    prev_system_sig: &mut String,
) {
    if let Ok(mut diag) = diag_arc.lock() {
        parse_log_into_state(buffer, &mut diag);
        diag.last_updated = Some(chrono::Local::now().format("%H:%M:%S").to_string());
        diag.session_has_data = has_any_diag_data(&diag);

        let current_sid = diag.system.as_ref().and_then(|s| s.sid.clone());
        if prev_sid.is_none() && current_sid.is_some() {
            if let Ok(h) = app_handle_arc.lock() {
                if let Some(handle) = h.as_ref() {
                    let _ = handle.emit("controller-sid-detected", current_sid.clone());
                }
            }
        }
        *prev_sid = current_sid;

        let current_system_sig = diag
            .system
            .as_ref()
            .map(|s| {
                format!(
                    "{:?}|{:?}|{:?}|{:?}|{:?}|{}",
                    s.version,
                    s.sid,
                    s.hydraulic_hardware_configuration,
                    s.preferred_network,
                    s.zone_count,
                    s.zones.len()
                )
            })
            .unwrap_or_default();
        if current_system_sig != *prev_system_sig && !current_system_sig.is_empty() {
            if let Ok(h) = app_handle_arc.lock() {
                if let Some(handle) = h.as_ref() {
                    let _ = handle.emit("system-config-updated", ());
                }
            }
        }
        *prev_system_sig = current_system_sig;

        let mut migrated_from: Option<String> = None;
        if let Some(sid) = diag
            .system
            .as_ref()
            .and_then(|system| system.sid.as_ref())
            .map(|sid| sid.trim())
            .filter(|sid| !sid.is_empty())
        {
            let sid_key = format!("vpn:{sid}");
            if sid_key != *active_controller_key {
                migrated_from = Some(active_controller_key.clone());
                *active_controller_key = sid_key.clone();
                if let Ok(mut key) = key_arc.lock() {
                    *key = Some(sid_key);
                }
            }
        }

        if let Ok(mut store) = store_arc.lock() {
            if let Some(old_key) = migrated_from {
                if let Some(previous) = store.controllers.remove(&old_key) {
                    let migrated = store
                        .controllers
                        .entry(active_controller_key.clone())
                        .or_insert_with(DiagnosticState::default);
                    merge_non_empty_cards(migrated, &previous);
                }
            }

            let entry = store
                .controllers
                .entry(active_controller_key.clone())
                .or_insert_with(DiagnosticState::default);
            merge_non_empty_cards(entry, &diag);
            save_diagnostic_store(&store);
        }
    }
}

fn start_log_watcher_internal(state: &AppState, start_from_end: bool) -> Result<(), String> {
    let (controller_key, log_path) = {
        let inner = state.inner.lock().map_err(|_| "lock poisoned")?;
        if inner.connection_mode == "local" {
            let device = inner
                .local_serial_device
                .clone()
                .ok_or_else(|| "No local serial device selected".to_string())?;
            (format!("serial:{device}"), local_serial_log_file(&device))
        } else {
            let ip = inner
                .controller_ip
                .clone()
                .ok_or_else(|| "No controller IP — connect first".to_string())?;
            (format!("vpn:{ip}"), log_file_path(&ip))
        }
    };
    state.watcher_paused.store(false, Ordering::SeqCst);

    let diag_arc = state.diagnostic_state.clone();
    let store_arc = state.diagnostic_store.clone();
    let key_arc = state.current_controller_key.clone();
    let watcher_paused = state.watcher_paused.clone();
    let watcher_pause_offset = state.watcher_pause_offset.clone();
    let app_handle_arc = state.app_handle.clone();

    if let Ok(mut key) = state.current_controller_key.lock() {
        *key = Some(controller_key.clone());
    }

    if let (Ok(mut diag), Ok(store)) = (state.diagnostic_state.lock(), state.diagnostic_store.lock())
    {
        if start_from_end {
            *diag = DiagnosticState::default();
        } else if let Some(cached) = store.controllers.get(&controller_key) {
            *diag = cached.clone();
            diag.session_has_data = false;
            diag.last_updated = None;
        } else {
            *diag = DiagnosticState::default();
        }
    }

    let kill_flag = Arc::new(AtomicBool::new(false));
    {
        let mut watcher = state
            .log_watcher_kill
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if let Some(existing) = watcher.take() {
            existing.store(true, Ordering::Relaxed);
        }
        *watcher = Some(kill_flag.clone());
    }

    thread::spawn(move || {
        let mut active_controller_key = controller_key.clone();
        let mut waited = 0;
        while !log_path.exists() && waited < 10 {
            if kill_flag.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(Duration::from_secs(1));
            waited += 1;
        }
        if !log_path.exists() {
            return;
        }

        let mut file = match std::fs::File::open(&log_path) {
            Ok(f) => f,
            Err(_) => return,
        };

        let _ = if start_from_end {
            file.seek(SeekFrom::End(0))
        } else {
            file.seek(SeekFrom::Start(0))
        };

        let mut prev_sid: Option<String> = None;
        let mut prev_system_sig: String = String::new();
        let mut buffer = String::new();
        loop {
            if kill_flag.load(Ordering::Relaxed) {
                break;
            }

            if watcher_paused.load(Ordering::SeqCst) {
                let current_size = log_path.metadata().map(|m| m.len()).unwrap_or(0);
                let pause_offset = watcher_pause_offset.lock().map(|g| *g).unwrap_or(0);
                if current_size <= pause_offset {
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }

                watcher_paused.store(false, Ordering::SeqCst);
                let _ = file.seek(SeekFrom::Start(pause_offset));
                buffer.clear();
                thread::sleep(Duration::from_millis(50));
                continue;
            }

            let mut chunk = String::new();
            match file.read_to_string(&mut chunk) {
                Ok(0) => thread::sleep(Duration::from_millis(500)),
                Ok(_) => {
                    buffer.push_str(&chunk);
                    ingest_diagnostic_buffer(
                        &buffer,
                        &diag_arc,
                        &store_arc,
                        &key_arc,
                        &app_handle_arc,
                        &mut active_controller_key,
                        &mut prev_sid,
                        &mut prev_system_sig,
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn start_log_watcher(state: State<'_, AppState>) -> Result<(), String> {
    start_log_watcher_internal(&state, false)
}

#[tauri::command]
fn get_diagnostic_state(state: State<'_, AppState>) -> Result<DiagnosticState, String> {
    let diag = state.diagnostic_state.lock().map_err(|_| "lock poisoned")?;
    Ok(diag.clone())
}

#[tauri::command]
fn clear_diagnostic_state(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut diag = state.diagnostic_state.lock().map_err(|_| "lock poisoned")?;
        *diag = DiagnosticState::default();
    }
    // Restart watcher from the current file end so newly-run diagnostics
    // repopulate cards cleanly after a clear action.
    start_log_watcher_internal(&state, true)?;
    Ok(())
}

fn clear_diagnostic_interface_state(diag: &mut DiagnosticState, interface: &str) {
    match interface {
        "wifi" => diag.wifi = None,
        "cellular" => diag.cellular = None,
        "satellite" => diag.satellite = None,
        "ethernet" => diag.ethernet = None,
        "pressure" => diag.pressure = None,
        "sim_picker" => diag.sim_picker = None,
        "system" => diag.system = None,
        _ => return,
    }
    diag.interface_runs.remove(interface);
}

#[tauri::command]
fn clear_diagnostic_interface(state: State<'_, AppState>, interface: String) -> Result<(), String> {
    let mut diag = state.diagnostic_state.lock().map_err(|_| "lock poisoned")?;
    clear_diagnostic_interface_state(&mut diag, &interface);
    Ok(())
}

#[tauri::command]
fn stop_log_watcher(state: State<'_, AppState>) -> Result<(), String> {
    let log_path = {
        let inner = state.inner.lock().map_err(|_| "lock poisoned")?;
        if inner.connection_mode == "local" {
            let device = inner
                .local_serial_device
                .clone()
                .ok_or_else(|| "No local serial device selected".to_string())?;
            local_serial_log_file(&device)
        } else {
            let ip = inner
                .controller_ip
                .clone()
                .ok_or_else(|| "No controller IP — connect first".to_string())?;
            log_file_path(&ip)
        }
    };

    let pause_offset = log_path.metadata().map(|m| m.len()).unwrap_or(0);
    if let Ok(mut offset) = state.watcher_pause_offset.lock() {
        *offset = pause_offset;
    }
    state.watcher_paused.store(true, Ordering::SeqCst);

    if let Ok(mut diag) = state.diagnostic_state.lock() {
        *diag = DiagnosticState::default();
    }

    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn stop_log_watcher_internal(state: &AppState) -> Result<(), String> {
    if let Ok(mut watcher) = state.log_watcher_kill.lock() {
        if let Some(existing) = watcher.take() {
            existing.store(true, Ordering::Relaxed);
        }
    }
    state.watcher_paused.store(false, Ordering::SeqCst);

    if let Ok(mut diag) = state.diagnostic_state.lock() {
        diag.session_has_data = false;
        diag.last_updated = None;
    }

    Ok(())
}

// ── VPN helpers ───────────────────────────────────────────────────────────────

fn run_vpn_start_transition(inner_state: Arc<Mutex<InnerState>>, folder: String) {
    let transition_token = match inner_state.lock() {
        Ok(inner) => inner.vpn_transition_token,
        Err(_) => return,
    };
    let result = do_vpn_start_transition(&inner_state, transition_token, &folder);
    if let Err(err) = result {
        if let Ok(mut inner) = inner_state.lock() {
            if inner.vpn_transition_token == transition_token {
                inner.vpn_phase = "failed".into();
                inner.vpn_detail = err.clone();
                inner.vpn_transition_in_flight = false;
                push_vpn_log(&mut inner, format!("Start transition failed: {err}"));
            }
        }
    }
}

fn do_vpn_start_transition(
    inner_state: &Arc<Mutex<InnerState>>,
    transition_token: u64,
    folder: &str,
) -> Result<(), String> {
    let existing_pids = collect_known_openvpn_pids(inner_state);
    #[cfg(target_os = "windows")]
    if !existing_pids.is_empty() {
        with_vpn_state(inner_state, transition_token, |inner| {
            push_vpn_log(
                inner,
                format!(
                    "Stale OpenVPN process cleanup requested for pid(s): {}",
                    existing_pids
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        })?;
        stop_openvpn_pids_elevated(&existing_pids)?;
        wait_for_processes_to_exit(&existing_pids, VPN_STALE_CLEANUP_TIMEOUT)?;
    }
    #[cfg(not(target_os = "windows"))]
    if !existing_pids.is_empty() {
        with_vpn_state(inner_state, transition_token, |inner| {
            push_vpn_log(
                inner,
                format!(
                    "Existing OpenVPN process(es) will be replaced during startup: {}",
                    existing_pids
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        })?;
    }
    with_vpn_state(inner_state, transition_token, |inner| {
        inner.managed_openvpn_pid = None;
        inner.managed_openvpn_log_path = None;
        inner.managed_openvpn_log_offset = 0;
        cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
        inner.vpn_cancel_requested = false;
    })?;

    let stage_dir = stage_bundle(folder)?;
    let staged_config = stage_dir.join("ovpn.conf");
    let openvpn_binary = resolve_openvpn()?;
    #[cfg(target_os = "windows")]
    {
        let binary_name = openvpn_binary
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if binary_name == "openvpnconnect.exe" {
            let pid = launch_openvpn_connect_windows(&staged_config)?;
            with_vpn_state(inner_state, transition_token, |inner| {
                inner.managed_openvpn_pid = Some(pid);
                inner.managed_openvpn_log_path = None;
                inner.managed_openvpn_log_offset = 0;
                inner.managed_openvpn_stage_dir = Some(stage_dir.to_string_lossy().into_owned());
                inner.vpn_phase = "manual".into();
                inner.vpn_detail =
                    "VPN app opened. Connect there, then return here and click Check.".into();
                push_vpn_log(inner, format!("Staged bundle -> {}", stage_dir.display()));
                push_vpn_log(
                    inner,
                    "Imported profile into the VPN app and opened it.".into(),
                );
                push_vpn_log(inner, format!("VPN app PID: {pid}"));
                inner.vpn_transition_in_flight = false;
            })?;
            return Ok(());
        }

        let log_path = vpn_log_path();
        let pid = launch_openvpn_windows(&stage_dir, &staged_config, &log_path, &openvpn_binary)?;

        with_vpn_state(inner_state, transition_token, |inner| {
            inner.managed_openvpn_pid = Some(pid);
            inner.managed_openvpn_log_path = Some(log_path.to_string_lossy().into_owned());
            inner.managed_openvpn_log_offset = 0;
            inner.managed_openvpn_stage_dir = Some(stage_dir.to_string_lossy().into_owned());
            inner.vpn_phase = "starting".into();
            inner.vpn_detail = "OpenVPN starting with administrator privileges".into();
            push_vpn_log(inner, format!("Staged bundle -> {}", stage_dir.display()));
            push_vpn_log(inner, format!("OpenVPN PID: {pid}"));
            push_vpn_log(inner, format!("Log file: {}", log_path.display()));
        })?;

        let started = std::time::Instant::now();
        while started.elapsed() < VPN_CONNECT_TIMEOUT {
            thread::sleep(Duration::from_millis(250));
            let mut should_stop = false;
            let mut done = false;
            with_vpn_state(inner_state, transition_token, |inner| {
                sync_vpn_logs(inner);
                if inner.vpn_cancel_requested {
                    should_stop = true;
                    inner.vpn_detail = "Startup cancelled; stopping OpenVPN...".into();
                } else if inner.vpn_phase == "connected" {
                    inner.vpn_transition_in_flight = false;
                    done = true;
                    push_vpn_log(inner, "OpenVPN transition complete: connected".into());
                } else if inner.vpn_phase == "failed" {
                    inner.vpn_transition_in_flight = false;
                    done = true;
                }
            })?;
            if done {
                return Ok(());
            }
            if should_stop {
                return do_vpn_stop_transition(inner_state, transition_token);
            }
        }

        with_vpn_state(inner_state, transition_token, |inner| {
            inner.vpn_phase = "failed".into();
            inner.vpn_detail = format!(
                "OpenVPN did not become ready within {} seconds",
                VPN_CONNECT_TIMEOUT.as_secs()
            );
            push_vpn_log(inner, inner.vpn_detail.clone());
        })?;
        return do_vpn_stop_transition(inner_state, transition_token);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let log_path = vpn_log_path();
        let launcher =
            write_launcher_script(&stage_dir, &staged_config, &log_path, &openvpn_binary)?;
        let pid = launch_openvpn_elevated(&launcher, &existing_pids)?;

        with_vpn_state(inner_state, transition_token, |inner| {
            inner.managed_openvpn_pid = Some(pid);
            inner.managed_openvpn_log_path = Some(log_path.to_string_lossy().into_owned());
            inner.managed_openvpn_log_offset = 0;
            inner.managed_openvpn_stage_dir = Some(stage_dir.to_string_lossy().into_owned());
            inner.vpn_phase = "starting".into();
            inner.vpn_detail = "OpenVPN starting with administrator privileges".into();
            push_vpn_log(inner, format!("Staged bundle → {}", stage_dir.display()));
            push_vpn_log(inner, format!("OpenVPN PID: {pid}"));
            push_vpn_log(inner, format!("Log file: {}", log_path.display()));
        })?;

        let started = std::time::Instant::now();
        while started.elapsed() < VPN_CONNECT_TIMEOUT {
            thread::sleep(Duration::from_millis(250));
            let mut should_stop = false;
            let mut done = false;
            with_vpn_state(inner_state, transition_token, |inner| {
                sync_vpn_logs(inner);
                if inner.vpn_cancel_requested {
                    should_stop = true;
                    inner.vpn_detail = "Startup cancelled; stopping OpenVPN…".into();
                } else if inner.vpn_phase == "connected" {
                    inner.vpn_transition_in_flight = false;
                    done = true;
                    push_vpn_log(inner, "OpenVPN transition complete: connected".into());
                } else if inner.vpn_phase == "failed" {
                    inner.vpn_transition_in_flight = false;
                    done = true;
                }
            })?;
            if done {
                return Ok(());
            }
            if should_stop {
                return do_vpn_stop_transition(inner_state, transition_token);
            }
        }

        with_vpn_state(inner_state, transition_token, |inner| {
            inner.vpn_phase = "failed".into();
            inner.vpn_detail = format!(
                "OpenVPN did not become ready within {} seconds",
                VPN_CONNECT_TIMEOUT.as_secs()
            );
            push_vpn_log(inner, inner.vpn_detail.clone());
        })?;
        do_vpn_stop_transition(inner_state, transition_token)
    }
}

fn run_vpn_stop_transition(inner_state: Arc<Mutex<InnerState>>) {
    let transition_token = match inner_state.lock() {
        Ok(inner) => inner.vpn_transition_token,
        Err(_) => return,
    };
    if let Err(err) = do_vpn_stop_transition(&inner_state, transition_token) {
        if let Ok(mut inner) = inner_state.lock() {
            if inner.vpn_transition_token == transition_token {
                inner.vpn_phase = "failed".into();
                inner.vpn_detail = err.clone();
                inner.vpn_transition_in_flight = false;
                push_vpn_log(&mut inner, format!("Stop transition failed: {err}"));
            }
        }
    }
}

fn do_vpn_stop_transition(
    inner_state: &Arc<Mutex<InnerState>>,
    transition_token: u64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let should_stop_connect = inner_state
            .lock()
            .ok()
            .map(|inner| inner.vpn_phase == "manual")
            .unwrap_or(false);
        if should_stop_connect {
            stop_openvpn_connect_windows()?;
        }
    }
    let pids = collect_known_openvpn_pids(inner_state);
    if !pids.is_empty() {
        stop_openvpn_pids_elevated(&pids)?;
        if wait_for_processes_to_exit(&pids, VPN_STOP_TIMEOUT).is_err() {
            stop_openvpn_pids_force_elevated(&pids)?;
            wait_for_processes_to_exit(&pids, Duration::from_secs(2))?;
        }
    }
    with_vpn_state(inner_state, transition_token, |inner| {
        cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
        inner.managed_openvpn_pid = None;
        inner.managed_openvpn_log_path = None;
        inner.managed_openvpn_log_offset = 0;
        inner.vpn_cancel_requested = false;
        inner.vpn_transition_in_flight = false;
        inner.vpn_phase = "disconnected".into();
        inner.vpn_detail = "OpenVPN stopped".into();
        push_vpn_log(inner, "OpenVPN transition complete: disconnected".into());
    })
}

fn with_vpn_state<F>(
    inner_state: &Arc<Mutex<InnerState>>,
    transition_token: u64,
    mut f: F,
) -> Result<(), String>
where
    F: FnMut(&mut InnerState),
{
    let mut inner = inner_state.lock().map_err(|_| "state lock poisoned")?;
    if inner.vpn_transition_token != transition_token {
        return Err("VPN transition superseded by a newer action".into());
    }
    f(&mut inner);
    Ok(())
}

fn collect_known_openvpn_pids(inner_state: &Arc<Mutex<InnerState>>) -> Vec<u32> {
    let mut pids = detect_openvpn_pids();
    if let Ok(inner) = inner_state.lock() {
        if let Some(pid) = inner.managed_openvpn_pid {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

fn wait_for_processes_to_exit(pids: &[u32], timeout: Duration) -> Result<(), String> {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if pids.iter().all(|pid| !process_alive(*pid)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "Timed out waiting for OpenVPN process(es) to exit after {}s",
        timeout.as_secs()
    ))
}

fn can_start_from(phase: &str) -> bool {
    matches!(phase, "disconnected" | "failed" | "manual" | "unknown")
}

fn can_stop_from(phase: &str) -> bool {
    matches!(phase, "connected" | "manual" | "starting")
}

fn stage_bundle(folder_path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(folder_path);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stage_dir = std::env::temp_dir().join(format!("fwds-vpn-stage-{ts}"));

    fs::create_dir_all(&stage_dir).map_err(|e| format!("Failed to create stage directory: {e}"))?;

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
        fs::copy(&src, &dst).map_err(|e| format!("Failed to copy {file_name} to stage: {e}"))?;

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
        // Windows equivalent of chmod 0600, followed by the in-process PPK
        // conversion PuTTY needs. Connect retries conversion and reports any
        // actionable error, so bundle staging remains usable for VPN startup.
        #[cfg(target_os = "windows")]
        {
            harden_windows_key_acl(&station_dst);
            let _ = ensure_station_ppk();
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
    std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join(".ssh"))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ssh")))
        .unwrap_or_else(|| std::env::temp_dir().join(".ssh"))
}

fn vpn_log_path() -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    std::env::temp_dir().join(format!("fwds-openvpn-{ts}.log"))
}

fn resolve_openvpn() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![
            PathBuf::from(r"C:\Program Files\OpenVPN\bin\openvpn.exe"),
            PathBuf::from(r"C:\Program Files (x86)\OpenVPN\bin\openvpn.exe"),
            PathBuf::from(r"C:\Program Files\OpenVPN Connect\OpenVPNConnect.exe"),
            PathBuf::from(r"C:\Program Files (x86)\OpenVPN Connect\OpenVPNConnect.exe"),
        ];
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(&program_files)
                    .join("OpenVPN")
                    .join("bin")
                    .join("openvpn.exe"),
            );
            candidates.push(
                PathBuf::from(program_files)
                    .join("OpenVPN Connect")
                    .join("OpenVPNConnect.exe"),
            );
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(&program_files_x86)
                    .join("OpenVPN")
                    .join("bin")
                    .join("openvpn.exe"),
            );
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join("OpenVPN Connect")
                    .join("OpenVPNConnect.exe"),
            );
        }
        for candidate in candidates {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        let out = Command::new("where")
            .arg("openvpn.exe")
            .output()
            .map_err(|e| format!("Failed to locate OpenVPN: {e}"))?;
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
        let out = Command::new("where")
            .arg("OpenVPNConnect.exe")
            .output()
            .map_err(|e| format!("Failed to locate OpenVPN Connect: {e}"))?;
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
        return Err(
            "OpenVPN was not found. Install OpenVPN Community or OpenVPN Connect and try again."
                .into(),
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
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
}

#[cfg(target_os = "windows")]
fn resolve_openvpn_connect() -> Result<PathBuf, String> {
    let mut candidates = vec![
        PathBuf::from(r"C:\Program Files\OpenVPN Connect\OpenVPNConnect.exe"),
        PathBuf::from(r"C:\Program Files (x86)\OpenVPN Connect\OpenVPNConnect.exe"),
    ];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("OpenVPN Connect")
                .join("OpenVPNConnect.exe"),
        );
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("OpenVPN Connect")
                .join("OpenVPNConnect.exe"),
        );
    }
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    let out = Command::new("where")
        .arg("OpenVPNConnect.exe")
        .output()
        .map_err(|e| format!("Failed to locate OpenVPN Connect: {e}"))?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout)
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    Err("OpenVPN Connect was not found.".into())
}

#[cfg(target_os = "windows")]
fn launch_openvpn_connect_windows(profile_path: &Path) -> Result<u32, String> {
    let openvpn_connect = resolve_openvpn_connect()?;
    let profile_arg = format!("--import-profile={}", profile_path.to_string_lossy());
    let profile_name = "FWDS Remote";
    let _ = Command::new(&openvpn_connect)
        .arg(format!("--remove-profile={profile_name}"))
        .status();

    let import_status = Command::new(&openvpn_connect)
        .args(["--accept-gdpr", "--skip-startup-dialogs"])
        .arg(profile_arg)
        .arg(format!("--name={profile_name}"))
        .status()
        .map_err(|e| format!("Failed to import profile into OpenVPN Connect: {e}"))?;

    if !import_status.success() {
        return Err(
            "OpenVPN Connect could not import the profile. Open OpenVPN Connect and import ovpn.conf manually."
                .into(),
        );
    }

    let child = Command::new(&openvpn_connect)
        .spawn()
        .map_err(|e| format!("Failed to open OpenVPN Connect: {e}"))?;
    Ok(child.id())
}

#[cfg(target_os = "windows")]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn launch_openvpn_windows(
    stage_dir: &Path,
    config_path: &Path,
    log_path: &Path,
    openvpn_binary: &Path,
) -> Result<u32, String> {
    let pid_path = stage_dir.join("openvpn.pid");
    let _ = fs::remove_file(log_path);
    let _ = fs::remove_file(&pid_path);

    let script = format!(
        "$process = Start-Process -FilePath {} -ArgumentList @({}, {}, {}, {}, {}, {}, {}, {}) -Verb RunAs -WindowStyle Hidden -PassThru; $process.Id",
        powershell_single_quote(&openvpn_binary.to_string_lossy()),
        powershell_single_quote("--cd"),
        powershell_single_quote(&stage_dir.to_string_lossy()),
        powershell_single_quote("--config"),
        powershell_single_quote(&config_path.to_string_lossy()),
        powershell_single_quote("--log"),
        powershell_single_quote(&log_path.to_string_lossy()),
        powershell_single_quote("--writepid"),
        powershell_single_quote(&pid_path.to_string_lossy()),
    );

    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| format!("Failed to start OpenVPN with administrator privileges: {e}"))?;

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
        .map_err(|_| format!("Unexpected output from PowerShell: '{}'", stdout.trim()))
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
    fs::write(&launcher, &script).map_err(|e| format!("Failed to write launcher script: {e}"))?;
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

#[cfg(target_os = "windows")]
fn stop_openvpn_connect_windows() -> Result<(), String> {
    let openvpn_connect = resolve_openvpn_connect()?;
    let quit_status = Command::new(&openvpn_connect)
        .arg("--quit")
        .status()
        .map_err(|e| format!("Failed to close OpenVPN Connect: {e}"))?;

    if quit_status.success() {
        return Ok(());
    }

    let pids = detect_openvpn_pids();
    if pids.is_empty() {
        Ok(())
    } else {
        stop_openvpn_pids_force_elevated(&pids)
    }
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

fn stop_openvpn_pids_elevated(pids: &[u32]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return stop_openvpn_pids_force_elevated(pids);
    }

    #[cfg(not(target_os = "windows"))]
    {
        if pids.is_empty() {
            return Ok(());
        }
        let pid_list = pids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "do shell script \"kill {} >/dev/null 2>&1 || true\" with administrator privileges",
            pid_list
        );
        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to invoke osascript to stop OpenVPN: {e}"))?;

        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.is_empty() {
                Err("Failed to stop the elevated OpenVPN process.".into())
            } else {
                Err(format!("Failed to stop OpenVPN: {stderr}"))
            }
        }
    }
}

fn stop_openvpn_pids_force_elevated(pids: &[u32]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if pids.is_empty() {
            return Ok(());
        }
        let mut taskkill_args = vec!["/F".to_string(), "/T".to_string()];
        for pid in pids {
            taskkill_args.push("/PID".to_string());
            taskkill_args.push(pid.to_string());
        }
        let argument_list = taskkill_args
            .iter()
            .map(|arg| powershell_single_quote(arg))
            .collect::<Vec<_>>()
            .join(", ");
        let script = format!(
            "$process = Start-Process -FilePath 'taskkill.exe' -ArgumentList @({argument_list}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode"
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| format!("Failed to force-close OpenVPN: {e}"))?;

        if out.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return if stderr.is_empty() && stdout.is_empty() {
            Err("Administrator approval was denied or cancelled while closing OpenVPN.".into())
        } else if stderr.is_empty() {
            Err(format!("Failed to force-close OpenVPN: {stdout}"))
        } else {
            Err(format!("Failed to force-close OpenVPN: {stderr}"))
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        if pids.is_empty() {
            return Ok(());
        }
        let pid_list = pids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "do shell script \"kill -9 {} >/dev/null 2>&1 || true\" with administrator privileges",
            pid_list
        );
        let out = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to force-stop OpenVPN with osascript: {e}"))?;

        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.is_empty() {
                Err("Failed to force-stop OpenVPN.".into())
            } else {
                Err(format!("Failed to force-stop OpenVPN: {stderr}"))
            }
        }
    }
}

fn sync_vpn_logs(inner: &mut InnerState) {
    let Some(ref log_path) = inner.managed_openvpn_log_path.clone() else {
        return;
    };
    let Ok(mut file) = fs::File::open(log_path) else {
        return;
    };
    if file
        .seek(SeekFrom::Start(inner.managed_openvpn_log_offset))
        .is_err()
    {
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
        push_vpn_log(inner, line.to_string());
    }

    // Detect openvpn death while still active
    if let Some(pid) = inner.managed_openvpn_pid {
        let should_watch_liveness = inner.vpn_phase == "starting" || inner.vpn_phase == "connected";
        if should_watch_liveness && !process_alive(pid) {
            inner.managed_openvpn_pid = None;
            cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
            inner.managed_openvpn_log_path = None;
            inner.managed_openvpn_log_offset = 0;
            if inner.vpn_phase == "starting" {
                inner.vpn_phase = "failed".into();
                inner.vpn_detail = "OpenVPN exited before establishing the tunnel.".into();
            } else {
                inner.vpn_phase = "disconnected".into();
                inner.vpn_detail = "OpenVPN tunnel dropped. Reconnect OpenVPN.".into();
            }
            push_vpn_log(inner, inner.vpn_detail.clone());
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
    #[cfg(target_os = "windows")]
    {
        return Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-Process openvpn,OpenVPNConnect,ovpnconnector -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
            ])
            .output()
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                    .collect()
            })
            .unwrap_or_default();
    }

    #[cfg(not(target_os = "windows"))]
    {
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
}

fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .map(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout);
                o.status.success()
                    && stdout.lines().any(|line| {
                        let trimmed = line.trim();
                        !trimmed.is_empty() && !trimmed.starts_with("INFO:")
                    })
            })
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .output()
            .ok()
            .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false)
    }
}

fn push_vpn_log(inner: &mut InnerState, msg: String) {
    inner.vpn_logs.push(msg);
    if inner.vpn_logs.len() > VPN_LOG_LIMIT {
        let overflow = inner.vpn_logs.len() - VPN_LOG_LIMIT;
        inner.vpn_logs.drain(0..overflow);
    }
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
    if let Some(mut child) = inner.windows_local_terminal_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(kill) = inner.windows_local_serial_kill.take() {
        kill.store(true, Ordering::Relaxed);
    }
    inner.windows_local_serial_writer = None;
    inner.shell_wizard_input = false;
    inner.shell_wizard_needs_clear = false;
    inner.shell_suppress_redraw = false;
    inner.shell_phase = "disconnected".into();
    inner.shell_detail = String::new();
    inner.external_terminal_window_id = None;
}

// ── String helpers ────────────────────────────────────────────────────────────

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn applescript_string_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// ── SD card flashing ──────────────────────────────────────────────────────────
//
// Writes a firmware image (.img / .img.gz) to a removable SD card with a single
// elevated step, streaming progress back through a tailed log file — mirroring
// the managed-OpenVPN pattern (launcher script → elevate once → poll a file).
// macOS writes the raw device in-process via `authopen` (no `dd`); Windows does a
// native raw `\\.\PhysicalDrive` write in an elevated PowerShell writer. Both
// verify the written bytes against the source.

#[derive(serde::Serialize, Clone)]
struct SdTarget {
    id: String, // macOS whole-disk id ("disk6") or Windows disk number ("6")
    name: String,
    size_bytes: u64,
    size_label: String,
    bus: String,
    removable: bool,
}

#[derive(serde::Serialize)]
struct FirmwareInfo {
    path: String,
    file_name: String,
    size_bytes: u64,
    size_label: String,
    compressed: bool,
}

#[derive(serde::Serialize)]
struct SdFlashPoll {
    phase: String,
    detail: String,
    percent: f64, // 0-100, or -1 when indeterminate
    bytes_done: u64,
    total_bytes: u64,
    rate_bps: u64,
    lines: Vec<String>,
}

fn human_size(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".into();
    }
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut val = bytes as f64;
    let mut unit = 0usize;
    while val >= 1000.0 && unit < UNITS.len() - 1 {
        val /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{val:.1} {}", UNITS[unit])
    }
}

fn is_terminal_sd_phase(phase: &str) -> bool {
    matches!(phase, "done" | "failed" | "cancelled")
}

fn sd_phase_detail(phase: &str) -> String {
    match phase {
        "preparing" => "Preparing the card…",
        "writing" => "Writing image to card…",
        "flushing" => "Flushing buffers…",
        "verifying" => "Verifying written data…",
        "ejecting" => "Ejecting card…",
        _ => "",
    }
    .to_string()
}

fn push_sd_log(inner: &mut InnerState, msg: String) {
    inner.sd_flash_logs.push(msg);
    if inner.sd_flash_logs.len() > VPN_LOG_LIMIT {
        let overflow = inner.sd_flash_logs.len() - VPN_LOG_LIMIT;
        inner.sd_flash_logs.drain(0..overflow);
    }
}

enum SdEvent {
    Phase(String),
    Progress { comp: u64, written: u64, rate: u64 },
    Verified,
    Failure(String),
    Exit(i32),
    Log(String),
}

fn parse_sd_line(line: &str) -> Option<SdEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if let Some(rest) = line.strip_prefix("PHASE ") {
        return Some(SdEvent::Phase(rest.trim().to_string()));
    }
    if let Some(rest) = line.strip_prefix("PROGRESS ") {
        let nums: Vec<u64> = rest
            .split_whitespace()
            .map(|t| t.parse().unwrap_or(0))
            .collect();
        return Some(SdEvent::Progress {
            comp: nums.first().copied().unwrap_or(0),
            written: nums.get(1).copied().unwrap_or(0),
            rate: nums.get(2).copied().unwrap_or(0),
        });
    }
    if line == "VERIFY_OK" {
        return Some(SdEvent::Verified);
    }
    if line.starts_with("VERIFY_FAIL") {
        return Some(SdEvent::Failure(
            "Verification failed — the card does not match the image.".into(),
        ));
    }
    if let Some(rest) = line.strip_prefix("WRITE_FAIL") {
        return Some(SdEvent::Failure(rest.trim().to_string()));
    }
    if let Some(rest) = line.strip_prefix("FLASH_EXIT") {
        return Some(SdEvent::Exit(rest.trim().parse::<i32>().unwrap_or(1)));
    }
    Some(SdEvent::Log(line.to_string()))
}

/// Tail the progress file and fold new lines into the SD-flash state.
fn sync_sd_flash(inner: &mut InnerState) {
    let Some(path) = inner.sd_flash_progress_path.clone() else {
        return;
    };
    let Ok(mut file) = fs::File::open(&path) else {
        return;
    };
    if file
        .seek(SeekFrom::Start(inner.sd_flash_progress_offset))
        .is_err()
    {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    inner.sd_flash_progress_offset += buf.len() as u64;

    for line in buf.lines() {
        match parse_sd_line(line) {
            None => {}
            Some(SdEvent::Phase(p)) => {
                if !is_terminal_sd_phase(&inner.sd_flash_phase) {
                    let detail = sd_phase_detail(&p);
                    inner.sd_flash_phase = p;
                    if !detail.is_empty() {
                        inner.sd_flash_detail = detail;
                    }
                }
            }
            Some(SdEvent::Progress {
                comp,
                written,
                rate,
            }) => {
                inner.sd_flash_comp_done = comp;
                inner.sd_flash_bytes_done = written;
                inner.sd_flash_rate_bps = rate;
            }
            Some(SdEvent::Verified) => {
                inner.sd_flash_detail = "Verification passed".into();
                push_sd_log(inner, "Verification passed".into());
            }
            Some(SdEvent::Failure(reason)) => {
                if !reason.is_empty() {
                    // Persist on state so a later-poll FLASH_EXIT still has it, and
                    // surface it immediately even before the exit line arrives.
                    inner.sd_flash_fail_detail = Some(reason.clone());
                    inner.sd_flash_detail = reason.clone();
                    push_sd_log(inner, reason);
                }
            }
            Some(SdEvent::Exit(code)) => {
                inner.sd_flash_in_flight = false;
                match code {
                    0 => {
                        inner.sd_flash_phase = "done".into();
                        inner.sd_flash_detail = "SD card ready".into();
                        inner.sd_flash_comp_done = inner.sd_flash_comp_total;
                        inner.sd_flash_fail_detail = None;
                    }
                    130 => {
                        inner.sd_flash_phase = "cancelled".into();
                        inner.sd_flash_detail = "Write cancelled".into();
                        inner.sd_flash_fail_detail = None;
                    }
                    _ => {
                        inner.sd_flash_phase = "failed".into();
                        inner.sd_flash_detail = inner
                            .sd_flash_fail_detail
                            .take()
                            .unwrap_or_else(|| format!("Write failed (code {code})"));
                    }
                }
            }
            Some(SdEvent::Log(l)) => push_sd_log(inner, l),
        }
    }
}

fn set_sd_failed(inner_state: &Arc<Mutex<InnerState>>, msg: String) {
    if let Ok(mut inner) = inner_state.lock() {
        inner.sd_flash_in_flight = false;
        inner.sd_flash_phase = "failed".into();
        inner.sd_flash_detail = msg.clone();
        push_sd_log(&mut inner, msg);
    }
}

#[cfg(not(target_os = "windows"))]
fn list_sd_targets_impl() -> Result<Vec<SdTarget>, String> {
    let out = Command::new("diskutil")
        .args(["list", "external", "physical"])
        .output()
        .map_err(|e| format!("Failed to run diskutil: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut ids = Vec::new();
    for line in stdout.lines() {
        // e.g. "/dev/disk6 (external, physical):"
        if line.starts_with("/dev/disk") && line.contains("external") {
            if let Some(id) = line.trim_start_matches("/dev/").split_whitespace().next() {
                ids.push(id.to_string());
            }
        }
    }
    let mut targets = Vec::new();
    for id in ids {
        if let Ok(info) = Command::new("diskutil").args(["info", &id]).output() {
            let text = String::from_utf8_lossy(&info.stdout);
            if let Some(t) = parse_diskutil_info(&text) {
                targets.push(t);
            }
        }
    }
    Ok(targets)
}

/// Parse `diskutil info <id>` text into an SD target, rejecting internal/virtual
/// disks. Kept standalone for unit testing.
#[cfg(not(target_os = "windows"))]
fn parse_diskutil_info(text: &str) -> Option<SdTarget> {
    let mut id = String::new();
    let mut name = String::new();
    let mut size_bytes: u64 = 0;
    let mut bus = String::new();
    let mut removable = false;
    let mut internal = false;
    let mut virtual_disk = false;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(v) = line.strip_prefix("Device Identifier:") {
            id = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Media Name:") {
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Device / Media Name:") {
            if name.is_empty() {
                name = v.trim().to_string();
            }
        } else if let Some(v) = line.strip_prefix("Protocol:") {
            bus = v.trim().to_string();
        } else if line.starts_with("Removable Media:") {
            removable = line.contains("Removable");
        } else if line.starts_with("Internal:") {
            internal = line.ends_with("Yes");
        } else if line.starts_with("Virtual:") {
            virtual_disk = line.ends_with("Yes");
        } else if (line.starts_with("Disk Size:") || line.starts_with("Total Size:"))
            && size_bytes == 0
        {
            if let Some(open) = line.find('(') {
                let digits: String = line[open + 1..]
                    .chars()
                    .take_while(|c| *c != ')')
                    .filter(char::is_ascii_digit)
                    .collect();
                size_bytes = digits.parse::<u64>().unwrap_or(0);
            }
        }
    }
    if id.is_empty() || size_bytes == 0 || internal || virtual_disk {
        return None;
    }
    let sd_like = bus.contains("Secure Digital") || bus.contains("USB") || removable;
    if !sd_like {
        return None;
    }
    Some(SdTarget {
        id: id.clone(),
        name: if name.is_empty() { id } else { name },
        size_bytes,
        size_label: human_size(size_bytes),
        removable: removable || bus.contains("Secure Digital"),
        bus,
    })
}

#[cfg(target_os = "windows")]
fn list_sd_targets_impl() -> Result<Vec<SdTarget>, String> {
    let ps = "Get-Disk | Where-Object { (-not $_.IsSystem) -and (-not $_.IsBoot) -and ($_.Size -gt 0) -and ($_.BusType -eq 'USB' -or $_.BusType -eq 'SD' -or $_.BusType -eq 'MMC') } | ForEach-Object { [PSCustomObject]@{ id = [string]$_.Number; name = $_.FriendlyName; size = [int64]$_.Size; bus = [string]$_.BusType } } | ConvertTo-Json -Compress";
    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps])
        .output()
        .map_err(|e| format!("Failed to run Get-Disk: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let val: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("Failed to parse disk list: {e}"))?;
    let items = match val {
        serde_json::Value::Array(a) => a,
        other => vec![other],
    };
    let mut targets = Vec::new();
    for it in items {
        let id = it
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let name = it
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let size = it.get("size").and_then(serde_json::Value::as_u64).unwrap_or(0);
        if size == 0 {
            continue;
        }
        let bus = it
            .get("bus")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        targets.push(SdTarget {
            id,
            name: if name.is_empty() {
                "Removable disk".into()
            } else {
                name
            },
            size_bytes: size,
            size_label: human_size(size),
            bus,
            removable: true,
        });
    }
    Ok(targets)
}

/// Open a raw disk device read/write via /usr/libexec/authopen.
///
/// authopen is macOS's setuid helper for exactly this job: it shows ONE admin
/// authorization prompt, opens the device on the user's authority, and passes
/// the open file descriptor back over a Unix socket (SCM_RIGHTS). Because the
/// app process then holds the fd itself, no Full Disk Access grant and no code
/// signing identity is needed — unlike `osascript … with administrator
/// privileges`, whose trampoline child has a TCC identity that is NOT this app
/// and therefore gets "Operation not permitted" on /dev/rdiskN regardless of
/// any grants. (Raspberry Pi Imager writes cards the same way.)
#[cfg(not(target_os = "windows"))]
fn authopen_rw_device(device_path: &str) -> Result<fs::File, String> {
    use std::os::fd::FromRawFd;

    let mut fds = [0i32; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) } != 0 {
        return Err("Could not create a socket pair for authopen.".into());
    }
    let (parent_fd, child_fd) = (fds[0], fds[1]);

    let child_stdout = unsafe { Stdio::from_raw_fd(child_fd) };
    let child = Command::new("/usr/libexec/authopen")
        .args(["-stdoutpipe", "-w", device_path])
        .stdout(child_stdout)
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            unsafe { libc::close(parent_fd) };
            return Err(format!("Failed to run authopen: {e}"));
        }
    };

    // Block until authopen sends the fd (after the user approves) or exits
    // (user cancelled the dialog → socket EOF).
    let received_fd = unsafe {
        let mut data = [0u8; 8];
        let mut iov = libc::iovec {
            iov_base: data.as_mut_ptr() as *mut libc::c_void,
            iov_len: data.len(),
        };
        // Space for one fd's cmsg, generously padded.
        let mut cmsg_buf = [0u8; 64];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cmsg_buf.as_mut_ptr() as *mut libc::c_void;
        msg.msg_controllen = cmsg_buf.len() as _;

        let n = libc::recvmsg(parent_fd, &mut msg, 0);
        if n < 0 {
            None
        } else {
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            if !cmsg.is_null()
                && (*cmsg).cmsg_level == libc::SOL_SOCKET
                && (*cmsg).cmsg_type == libc::SCM_RIGHTS
            {
                let fd = *(libc::CMSG_DATA(cmsg) as *const i32);
                if fd >= 0 {
                    Some(fd)
                } else {
                    None
                }
            } else {
                None
            }
        }
    };
    unsafe { libc::close(parent_fd) };
    let _ = child.wait();

    match received_fd {
        Some(fd) => Ok(unsafe { fs::File::from_raw_fd(fd) }),
        None => Err("Administrator approval was denied or cancelled.".into()),
    }
}

/// In-process macOS flash: unmount, authopen the raw device, stream the staged
/// (already decompressed) image onto it with direct progress/cancel handling,
/// read-back verify on the same fd, then eject. No elevated child process
/// touches any file — the app writes the disk itself.
#[cfg(not(target_os = "windows"))]
fn run_sd_flash_macos(
    inner_state: &Arc<Mutex<InnerState>>,
    staged_image: &Path,
    device_id: &str,
) {
    let set_phase = |phase: &str, detail: &str| {
        if let Ok(mut inner) = inner_state.lock() {
            if !is_terminal_sd_phase(&inner.sd_flash_phase) {
                inner.sd_flash_phase = phase.into();
                inner.sd_flash_detail = detail.into();
            }
            push_sd_log(&mut inner, detail.into());
        }
    };
    let cancelled = || {
        inner_state
            .lock()
            .map(|i| i.sd_flash_cancel_requested)
            .unwrap_or(false)
    };
    let finish_cancelled = |staged: &Path| {
        let _ = fs::remove_file(staged);
        if let Ok(mut inner) = inner_state.lock() {
            inner.sd_flash_in_flight = false;
            inner.sd_flash_phase = "cancelled".into();
            inner.sd_flash_detail = "Write cancelled".into();
            push_sd_log(&mut inner, "Write cancelled".into());
        }
    };
    let fail = |staged: &Path, msg: String| {
        let _ = fs::remove_file(staged);
        set_sd_failed(inner_state, msg);
    };

    set_phase("preparing", &format!("Unmounting /dev/{device_id}…"));
    match Command::new("diskutil")
        .args(["unmountDisk", device_id])
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            let err = if err.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            } else {
                err.trim().to_string()
            };
            fail(staged_image, format!("Could not unmount the card: {err}"));
            return;
        }
        Err(e) => {
            fail(staged_image, format!("Could not run diskutil: {e}"));
            return;
        }
    }

    set_phase(
        "preparing",
        "Waiting for permission — enter your password in the macOS dialog…",
    );
    let rdev = format!("/dev/r{device_id}");
    let mut disk = match authopen_rw_device(&rdev) {
        Ok(f) => f,
        Err(e) => {
            fail(staged_image, e);
            return;
        }
    };

    let mut src = match fs::File::open(staged_image) {
        Ok(f) => f,
        Err(e) => {
            fail(
                staged_image,
                format!("Could not open the prepared image: {e}"),
            );
            return;
        }
    };
    let total = fs::metadata(staged_image).map(|m| m.len()).unwrap_or(0);

    set_phase("writing", "Writing image to card…");
    const CHUNK: usize = 4 * 1024 * 1024;
    let mut buf = vec![0u8; CHUNK];
    let mut written: u64 = 0;
    let mut last_tick = std::time::Instant::now();
    let mut last_bytes: u64 = 0;
    loop {
        if cancelled() {
            drop(disk);
            let _ = Command::new("diskutil").args(["eject", device_id]).output();
            finish_cancelled(staged_image);
            return;
        }
        // Fill the buffer fully so raw-device writes stay large and aligned.
        let mut got = 0usize;
        while got < CHUNK {
            match src.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) => {
                    fail(staged_image, format!("Failed reading the image: {e}"));
                    return;
                }
            }
        }
        if got == 0 {
            break;
        }
        // Raw devices reject writes that aren't multiples of the 512-byte
        // sector; zero-pad the final chunk if needed.
        let mut write_len = got;
        if write_len % 512 != 0 {
            write_len = (got / 512 + 1) * 512;
            for b in &mut buf[got..write_len] {
                *b = 0;
            }
        }
        if let Err(e) = disk.write_all(&buf[..write_len]) {
            fail(staged_image, format!("Card write failed: {e}"));
            return;
        }
        written += got as u64;

        let now = std::time::Instant::now();
        let dt = now.duration_since(last_tick);
        if dt.as_millis() >= 500 {
            let rate = ((written - last_bytes) as f64 / dt.as_secs_f64()) as u64;
            last_tick = now;
            last_bytes = written;
            if let Ok(mut inner) = inner_state.lock() {
                inner.sd_flash_comp_done = written;
                inner.sd_flash_bytes_done = written;
                inner.sd_flash_rate_bps = rate;
            }
        }
    }
    if let Ok(mut inner) = inner_state.lock() {
        inner.sd_flash_comp_done = written;
        inner.sd_flash_bytes_done = written;
        inner.sd_flash_rate_bps = 0;
    }

    set_phase("flushing", "Flushing buffers…");
    let _ = disk.sync_all();

    set_phase("verifying", "Verifying written data…");
    let verify_result: Result<bool, String> = (|| {
        disk.seek(SeekFrom::Start(0))
            .map_err(|e| format!("seek: {e}"))?;
        src.seek(SeekFrom::Start(0))
            .map_err(|e| format!("seek: {e}"))?;
        let mut disk_buf = vec![0u8; CHUNK];
        let mut src_buf = vec![0u8; CHUNK];
        let mut remaining = total;
        while remaining > 0 {
            if cancelled() {
                return Err("cancelled".into());
            }
            let want = remaining.min(CHUNK as u64) as usize;
            let mut got = 0usize;
            while got < want {
                match src.read(&mut src_buf[got..want]) {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(e) => return Err(format!("image read: {e}")),
                }
            }
            if got == 0 {
                break;
            }
            let mut disk_got = 0usize;
            while disk_got < got {
                match disk.read(&mut disk_buf[disk_got..got]) {
                    Ok(0) => break,
                    Ok(n) => disk_got += n,
                    Err(e) => return Err(format!("card read: {e}")),
                }
            }
            if disk_got < got || disk_buf[..got] != src_buf[..got] {
                return Ok(false);
            }
            remaining -= got as u64;
        }
        Ok(true)
    })();
    match verify_result {
        Ok(true) => {
            if let Ok(mut inner) = inner_state.lock() {
                push_sd_log(&mut inner, "Verification passed".into());
            }
        }
        Ok(false) => {
            drop(disk);
            fail(
                staged_image,
                "Verification failed — the card does not match the image.".into(),
            );
            return;
        }
        Err(e) if e == "cancelled" => {
            drop(disk);
            let _ = Command::new("diskutil").args(["eject", device_id]).output();
            finish_cancelled(staged_image);
            return;
        }
        Err(e) => {
            // The write itself succeeded and was flushed; a verify-read failure
            // (e.g. a write-only fd) shouldn't scrap the card. Log and continue.
            if let Ok(mut inner) = inner_state.lock() {
                push_sd_log(&mut inner, format!("Read-back verification skipped: {e}"));
            }
        }
    }

    drop(disk);
    set_phase("ejecting", "Ejecting card…");
    let _ = Command::new("diskutil").args(["eject", device_id]).output();

    let _ = fs::remove_file(staged_image);
    if let Ok(mut inner) = inner_state.lock() {
        inner.sd_flash_in_flight = false;
        inner.sd_flash_phase = "done".into();
        inner.sd_flash_detail = "SD card ready".into();
        inner.sd_flash_comp_done = inner.sd_flash_comp_total;
        push_sd_log(&mut inner, "SD card ready".into());
    }
}

#[cfg(target_os = "windows")]
fn launch_sd_flash(
    stage_dir: &Path,
    progress_path: &Path,
    cancel_path: &Path,
    image_path: &str,
    device_id: &str,
    compressed: bool,
) -> Result<u32, String> {
    let disk_num: i64 = device_id
        .parse()
        .map_err(|_| "Invalid disk number".to_string())?;
    let template = r#"$ErrorActionPreference='Stop'
$img='@@IMG@@'
$prog='@@PROG@@'
$cancel='@@CANCEL@@'
$diskNum=@@DISKNUM@@
$compressed=@@COMP@@
function Log($m){ Add-Content -LiteralPath $prog -Value $m }
try {
  Log 'PHASE preparing'
  $disk = Get-Disk -Number $diskNum
  if ($disk.IsBoot -or $disk.IsSystem) { Log 'WRITE_FAIL Refusing to write to the system or boot disk'; Log 'FLASH_EXIT 2'; return }
  try { Clear-Disk -Number $diskNum -RemoveData -RemoveOEM -Confirm:$false } catch { }
  try { Set-Disk -Number $diskNum -IsReadOnly $false } catch { }
  try { Set-Disk -Number $diskNum -IsOffline $true } catch { }
  Log 'PHASE writing'
  $dev = '\\.\PhysicalDrive' + $diskNum
  $srcFile = New-Object System.IO.FileStream($img,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read)
  $compLen = $srcFile.Length
  if ($compressed) { $src = New-Object System.IO.Compression.GZipStream($srcFile,[System.IO.Compression.CompressionMode]::Decompress) } else { $src = $srcFile }
  $dst = New-Object System.IO.FileStream($dev,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Write,[System.IO.FileShare]::ReadWrite)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $buf = New-Object byte[] (4194304)
  $written = [int64]0
  $lastTick = [Environment]::TickCount
  $lastBytes = [int64]0
  while ($true) {
    if (Test-Path -LiteralPath $cancel) { $dst.Dispose(); $src.Dispose(); Log 'FLASH_EXIT 130'; return }
    $got = 0
    while ($got -lt $buf.Length) { $n = $src.Read($buf,$got,$buf.Length-$got); if ($n -le 0) { break }; $got += $n }
    if ($got -le 0) { break }
    $writeLen = $got
    if (($got % 512) -ne 0) { $writeLen = [int]([math]::Ceiling($got/512.0))*512; [Array]::Clear($buf,$got,$writeLen-$got) }
    $dst.Write($buf,0,$writeLen)
    $sha.TransformBlock($buf,0,$got,$null,0) | Out-Null
    $written += $got
    $now = [Environment]::TickCount
    if (($now - $lastTick) -ge 1000) {
      $rate = [int64]((($written - $lastBytes) * 1000) / [math]::Max(1,($now - $lastTick)))
      Log ('PROGRESS {0} {1} {2}' -f $srcFile.Position, $written, $rate)
      $lastTick = $now; $lastBytes = $written
    }
  }
  $dst.Flush($true); $dst.Dispose(); $src.Dispose()
  $sha.TransformFinalBlock($buf,0,0) | Out-Null
  $srcHash = ([BitConverter]::ToString($sha.Hash)).Replace('-','')
  Log ('PROGRESS {0} {1} 0' -f $compLen, $written)
  Log 'PHASE flushing'
  Log 'PHASE verifying'
  $rd = New-Object System.IO.FileStream($dev,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)
  $sha2 = [System.Security.Cryptography.SHA256]::Create()
  $remaining = $written
  while ($remaining -gt 0) {
    # Raw \\.\PhysicalDrive reads must be sector-aligned, so always request the
    # full (512-multiple) buffer and hash only the meaningful bytes; a non-aligned
    # trailing read would throw and be misread as a write failure.
    $n = $rd.Read($buf,0,$buf.Length)
    if ($n -le 0) { break }
    $use = [int][math]::Min([int64]$n,$remaining)
    $sha2.TransformBlock($buf,0,$use,$null,0) | Out-Null
    $remaining -= $use
  }
  $sha2.TransformFinalBlock($buf,0,0) | Out-Null
  $rd.Dispose()
  $dstHash = ([BitConverter]::ToString($sha2.Hash)).Replace('-','')
  if ($srcHash -ne $dstHash) { Log 'VERIFY_FAIL'; try { Set-Disk -Number $diskNum -IsOffline $false } catch { }; Log 'FLASH_EXIT 3'; return }
  Log 'VERIFY_OK'
  Log 'PHASE ejecting'
  try { Set-Disk -Number $diskNum -IsOffline $false } catch { }
  Log 'FLASH_EXIT 0'
} catch {
  Log ('WRITE_FAIL ' + $_.Exception.Message)
  Log 'FLASH_EXIT 1'
}
"#;
    let script = template
        .replace("@@IMG@@", &image_path.replace('\'', "''"))
        .replace("@@PROG@@", &progress_path.to_string_lossy().replace('\'', "''"))
        .replace("@@CANCEL@@", &cancel_path.to_string_lossy().replace('\'', "''"))
        .replace("@@DISKNUM@@", &disk_num.to_string())
        .replace("@@COMP@@", if compressed { "$true" } else { "$false" });
    let ps_path = stage_dir.join("flash-sdcard.ps1");
    fs::write(&ps_path, &script).map_err(|e| format!("Failed to write flash script: {e}"))?;

    let inner = format!(
        "$p = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',{}) -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id",
        powershell_single_quote(&ps_path.to_string_lossy())
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &inner])
        .output()
        .map_err(|e| format!("Failed to start the write with administrator privileges: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Administrator approval was denied or cancelled.".into()
        } else {
            format!("Could not start the write with administrator privileges: {stderr}")
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("Unexpected output from PowerShell: '{}'", stdout.trim()))
}

fn run_sd_flash(
    inner_state: Arc<Mutex<InnerState>>,
    image_path: String,
    device_id: String,
    compressed: bool,
) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stage_dir = std::env::temp_dir().join(format!("fwds-sdcard-{ts}"));
    if let Err(e) = fs::create_dir_all(&stage_dir) {
        set_sd_failed(&inner_state, format!("Failed to create work directory: {e}"));
        return;
    }
    let progress_path = stage_dir.join("progress.log");
    if fs::write(&progress_path, b"").is_err() {
        set_sd_failed(&inner_state, "Failed to create the progress log.".into());
        return;
    }
    let cancel_path = stage_dir.join("cancel");

    if let Ok(mut inner) = inner_state.lock() {
        inner.sd_flash_stage_dir = Some(stage_dir.to_string_lossy().into_owned());
        inner.sd_flash_progress_path = Some(progress_path.to_string_lossy().into_owned());
        inner.sd_flash_progress_offset = 0;
    }

    // On macOS everything runs in THIS process: the source read happens here
    // (the app holds the file-picker grant, so protected folders like
    // ~/Downloads work), the image is staged as plaintext in temp, and the raw
    // device is opened via authopen — no elevated child process, no Full Disk
    // Access requirement. Windows has no TCC and keeps the elevated
    // PowerShell writer.
    #[cfg(not(target_os = "windows"))]
    {
        let staged = stage_dir.join("image.img");
        if compressed {
            if let Ok(mut inner) = inner_state.lock() {
                inner.sd_flash_phase = "preparing".into();
                inner.sd_flash_detail = "Decompressing image…".into();
                push_sd_log(&mut inner, "Decompressing image before write…".into());
            }
            let outfile = match fs::File::create(&staged) {
                Ok(f) => f,
                Err(e) => {
                    set_sd_failed(&inner_state, format!("Could not create staging file: {e}"));
                    return;
                }
            };
            let result = Command::new("gunzip")
                .arg("-c")
                .arg(&image_path)
                .stdout(Stdio::from(outfile))
                .stderr(Stdio::piped())
                .spawn()
                .and_then(|child| child.wait_with_output());
            match result {
                Ok(out) if out.status.success() => {}
                Ok(out) => {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    let _ = fs::remove_file(&staged);
                    set_sd_failed(
                        &inner_state,
                        if err.is_empty() {
                            "Could not decompress the image.".into()
                        } else {
                            err
                        },
                    );
                    return;
                }
                Err(e) => {
                    let _ = fs::remove_file(&staged);
                    set_sd_failed(&inner_state, format!("Could not run the decompressor: {e}"));
                    return;
                }
            }
        } else {
            if let Ok(mut inner) = inner_state.lock() {
                inner.sd_flash_phase = "preparing".into();
                inner.sd_flash_detail = "Preparing image…".into();
            }
            if let Err(e) = fs::copy(&image_path, &staged) {
                set_sd_failed(&inner_state, format!("Could not read the image: {e}"));
                return;
            }
        }
        // Staged file is plaintext; retarget totals so progress tracks the
        // decompressed size.
        let plaintext_len = fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
        if plaintext_len == 0 {
            set_sd_failed(&inner_state, "The prepared image is empty.".into());
            return;
        }
        if let Ok(mut inner) = inner_state.lock() {
            inner.sd_flash_comp_total = plaintext_len;
            inner.sd_flash_compressed = false;
        }
        let _ = &cancel_path; // cancellation is signalled via state on macOS
        run_sd_flash_macos(&inner_state, &staged, &device_id);
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = compressed;
        let pid = match launch_sd_flash(
            &stage_dir,
            &progress_path,
            &cancel_path,
            &image_path,
            &device_id,
            compressed,
        ) {
            Ok(pid) => pid,
            Err(e) => {
                set_sd_failed(&inner_state, e);
                return;
            }
        };

        if let Ok(mut inner) = inner_state.lock() {
            inner.sd_flash_pid = Some(pid);
            inner.sd_flash_detail = "Writing with administrator privileges…".into();
            push_sd_log(&mut inner, format!("Writer started (pid {pid})"));
        }

    loop {
        thread::sleep(Duration::from_millis(500));
        let mut terminal = false;
        let mut pid_dead = false;
        if let Ok(mut inner) = inner_state.lock() {
            sync_sd_flash(&mut inner);
            if !inner.sd_flash_in_flight || is_terminal_sd_phase(&inner.sd_flash_phase) {
                terminal = true;
            } else if let Some(p) = inner.sd_flash_pid {
                pid_dead = !process_alive(p);
            }
        }
        if terminal {
            break;
        }
        if pid_dead {
            // Grace re-read in case the FLASH_EXIT line is still being flushed.
            thread::sleep(Duration::from_millis(400));
            if let Ok(mut inner) = inner_state.lock() {
                sync_sd_flash(&mut inner);
                if !is_terminal_sd_phase(&inner.sd_flash_phase) {
                    inner.sd_flash_in_flight = false;
                    inner.sd_flash_phase = "failed".into();
                    inner.sd_flash_detail = "The writer process exited unexpectedly.".into();
                    push_sd_log(&mut inner, "Writer process exited without completing.".into());
                }
            }
            break;
        }
    }
    }
}

#[tauri::command]
fn list_sd_targets() -> Result<Vec<SdTarget>, String> {
    list_sd_targets_impl()
}

#[tauri::command]
async fn select_firmware_image(app: tauri::AppHandle) -> Result<FirmwareInfo, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("Firmware image", &["img", "gz"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Err("No file selected".into());
    };
    let path_str = picked.to_string();
    let pb = PathBuf::from(&path_str);
    let file_name = pb
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let lower = file_name.to_lowercase();
    if !(lower.ends_with(".img") || lower.ends_with(".img.gz") || lower.ends_with(".gz")) {
        return Err("Please choose a .img or .img.gz firmware image.".into());
    }
    let meta = fs::metadata(&pb).map_err(|e| format!("Cannot read file: {e}"))?;
    let size_bytes = meta.len();
    Ok(FirmwareInfo {
        path: path_str,
        file_name,
        size_bytes,
        size_label: human_size(size_bytes),
        compressed: lower.ends_with(".gz"),
    })
}

#[tauri::command]
fn start_sd_flash(
    image_path: String,
    device_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if inner.sd_flash_in_flight {
            return Err("A card write is already in progress.".into());
        }
    }
    let meta = fs::metadata(&image_path)
        .map_err(|_| "Firmware image not found. Choose it again.".to_string())?;
    let comp_total = meta.len();
    if comp_total == 0 {
        return Err("The selected firmware image is empty.".into());
    }
    let compressed = image_path.to_lowercase().ends_with(".gz");

    // Defense-in-depth: re-confirm the device is still a removable target.
    let targets = list_sd_targets_impl().unwrap_or_default();
    let Some(target) = targets.iter().find(|t| t.id == device_id) else {
        return Err("That SD card is no longer connected. Click Refresh and pick it again.".into());
    };
    let target_label = format!("{} ({})", target.name, target.size_label);

    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        cleanup_stage_dir(inner.sd_flash_stage_dir.take());
        inner.sd_flash_logs.clear();
        inner.sd_flash_phase = "preparing".into();
        inner.sd_flash_detail = "Preparing…".into();
        inner.sd_flash_fail_detail = None;
        inner.sd_flash_progress_path = None;
        inner.sd_flash_progress_offset = 0;
        inner.sd_flash_comp_total = comp_total;
        inner.sd_flash_comp_done = 0;
        inner.sd_flash_bytes_done = 0;
        inner.sd_flash_rate_bps = 0;
        inner.sd_flash_compressed = compressed;
        inner.sd_flash_in_flight = true;
        inner.sd_flash_cancel_requested = false;
        inner.sd_flash_pid = None;
        push_sd_log(&mut inner, format!("Writing image to {target_label}"));
    }

    let inner_state = state.inner.clone();
    thread::spawn(move || run_sd_flash(inner_state, image_path, device_id, compressed));
    Ok(())
}

#[tauri::command]
fn poll_sd_flash(state: State<'_, AppState>) -> Result<SdFlashPoll, String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    sync_sd_flash(&mut inner);
    let percent = if inner.sd_flash_comp_total > 0 {
        ((inner.sd_flash_comp_done as f64 / inner.sd_flash_comp_total as f64) * 100.0)
            .clamp(0.0, 100.0)
    } else {
        -1.0
    };
    let total_bytes = if inner.sd_flash_compressed {
        0
    } else {
        inner.sd_flash_comp_total
    };
    Ok(SdFlashPoll {
        phase: inner.sd_flash_phase.clone(),
        detail: inner.sd_flash_detail.clone(),
        percent,
        bytes_done: inner.sd_flash_bytes_done,
        total_bytes,
        rate_bps: inner.sd_flash_rate_bps,
        lines: inner.sd_flash_logs.clone(),
    })
}

#[tauri::command]
fn cancel_sd_flash(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
    if !inner.sd_flash_in_flight {
        return Ok(());
    }
    inner.sd_flash_cancel_requested = true;
    inner.sd_flash_detail = "Cancelling…".into();
    if let Some(dir) = inner.sd_flash_stage_dir.clone() {
        let _ = fs::write(Path::new(&dir).join("cancel"), b"1");
    }
    push_sd_log(&mut inner, "Cancellation requested".into());
    Ok(())
}

/// Open System Settings → Privacy & Security → Full Disk Access so the user can
/// grant the app permission to write removable disks. Done in Rust via `open`
/// rather than the opener plugin so the custom `x-apple.systempreferences:`
/// scheme isn't subject to the plugin's URL scope.
#[tauri::command]
fn open_fda_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|e| format!("Failed to open System Settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Full Disk Access settings are only applicable on macOS".into())
    }
}

// ── App setup ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut initial_inner = InnerState::default();
    initial_inner.vpn_phase = "disconnected".into();
    initial_inner.shell_phase = "disconnected".into();
    initial_inner.connection_mode = "vpn".into();
    initial_inner.sd_flash_phase = "idle".into();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            inner: Arc::new(Mutex::new(initial_inner)),
            diagnostic_state: Arc::new(Mutex::new(DiagnosticState::default())),
            log_watcher_kill: Arc::new(Mutex::new(None)),
            watcher_paused: Arc::new(AtomicBool::new(false)),
            watcher_pause_offset: Arc::new(Mutex::new(0)),
            diagnostic_store: Arc::new(Mutex::new(load_diagnostic_store())),
            current_controller_key: Arc::new(Mutex::new(None)),
            app_handle: Arc::new(Mutex::new(None)),
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
            send_external_input,
            send_interrupt,
            toggle_debug,
            disconnect_controller,
            run_preflight,
            check_dependencies,
            open_controller_terminal,
            list_serial_devices,
            open_local_serial_terminal,
            open_local_network_terminal,
            discover_controllers,
            disconnect_local_controller,
            get_app_state,
            start_log_watcher,
            get_diagnostic_state,
            clear_diagnostic_state,
            clear_diagnostic_interface,
            stop_log_watcher,
            list_sd_targets,
            select_firmware_image,
            start_sd_flash,
            poll_sd_flash,
            cancel_sd_flash,
            open_fda_settings,
            get_log_settings,
            set_transcript_logging,
            reveal_log_dir,
            quit_app,
        ])
        .setup(|app| {
            let state: tauri::State<AppState> = app.state();
            if let Ok(mut h) = state.app_handle.lock() {
                *h = Some(app.handle().clone());
            }
            // Apply the persisted logging preference, relocate any transcripts
            // an older build left on the Desktop, then prune stale files.
            TRANSCRIPT_LOGGING.store(
                load_app_settings().transcript_logging_enabled,
                Ordering::Relaxed,
            );
            migrate_legacy_transcripts();
            prune_old_transcripts();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redact(text: &str) -> String {
        let mut state = RedactState { armed: false };
        redact_secrets(&mut state, text)
    }

    #[test]
    fn redacts_inline_secret_values() {
        assert_eq!(
            redact("Wi-Fi password: hunter2\n"),
            "Wi-Fi password: ••••[redacted]\n"
        );
        assert_eq!(redact("PSK=hunter2"), "PSK=••••[redacted]");
        assert_eq!(
            redact("passphrase = s3cret\n"),
            "passphrase = ••••[redacted]\n"
        );
    }

    #[test]
    fn redacts_bracketed_prefill_and_typed_value() {
        assert_eq!(
            redact("Wi-Fi password [oldpass]: newpass\n"),
            "Wi-Fi password [••••[redacted]]: ••••[redacted]\n"
        );
    }

    #[test]
    fn redacts_password_echoed_in_a_later_chunk() {
        // The macOS SSH reader can split the prompt and the value echoed back
        // across two append_transcript calls; the secret must still be masked.
        let mut state = RedactState { armed: false };
        let prompt = redact_secrets(&mut state, "Enter Wi-Fi password: ");
        assert_eq!(prompt, "Enter Wi-Fi password: ");
        assert!(state.armed);
        let echo = redact_secrets(&mut state, "hunter2\n");
        assert_eq!(echo, "••••[redacted]\n");
        assert!(!state.armed);
    }

    #[test]
    fn keeps_non_secret_lines_intact() {
        assert_eq!(redact("controller: 10.8.0.1\n"), "controller: 10.8.0.1\n");
        assert_eq!(redact("SSID: FrontlineNet\n"), "SSID: FrontlineNet\n");
        // "password" in prose (no prompt/assignment) is left readable.
        assert_eq!(
            redact("The password was updated\n"),
            "The password was updated\n"
        );
    }

    #[test]
    fn transcripts_never_live_on_desktop_or_documents() {
        let lossy = controller_logs_dir().to_string_lossy().to_lowercase();
        assert!(!lossy.contains("desktop"), "must not be on the Desktop: {lossy}");
        assert!(
            !lossy.contains("documents"),
            "must not be in Documents: {lossy}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn resolve_unix_command_finds_present_tool() {
        // `sh` exists on every Unix host, so the dependency preflight must
        // resolve it; a nonsense name must resolve to nothing.
        assert!(resolve_unix_command("sh").is_some());
        assert!(resolve_unix_command("definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn check_dependencies_covers_every_method() {
        let deps = check_dependencies();
        // One entry per connection method, each with a non-empty label/hint.
        let mut methods: Vec<&str> = deps.iter().map(|d| d.method.as_str()).collect();
        methods.sort();
        assert_eq!(methods, vec!["network", "serial", "vpn"]);
        for d in &deps {
            assert!(!d.label.is_empty());
            assert!(!d.install_hint.is_empty());
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn require_unix_command_reports_missing_with_message() {
        assert!(require_unix_command("sh", "unused").is_ok());
        let err = require_unix_command(
            "definitely-not-a-real-binary-xyz",
            "install it with: brew install foo",
        )
        .unwrap_err();
        assert_eq!(err, "install it with: brew install foo");
    }

    #[test]
    fn vpn_start_state_rules() {
        assert!(can_start_from("disconnected"));
        assert!(can_start_from("failed"));
        assert!(can_start_from("unknown"));
        assert!(!can_start_from("starting"));
        assert!(!can_start_from("connected"));
        assert!(!can_start_from("stopping"));
    }

    #[test]
    fn vpn_stop_state_rules() {
        assert!(can_stop_from("starting"));
        assert!(can_stop_from("connected"));
        assert!(!can_stop_from("disconnected"));
        assert!(!can_stop_from("failed"));
        assert!(!can_stop_from("stopping"));
    }

    #[test]
    fn vpn_log_buffer_is_bounded() {
        let mut inner = InnerState::default();
        for i in 0..(VPN_LOG_LIMIT + 25) {
            push_vpn_log(&mut inner, format!("line-{i}"));
        }
        assert_eq!(inner.vpn_logs.len(), VPN_LOG_LIMIT);
        assert_eq!(inner.vpn_logs.first().map(String::as_str), Some("line-25"));
        let expected_last = format!("line-{}", VPN_LOG_LIMIT + 24);
        assert_eq!(
            inner.vpn_logs.last().map(String::as_str),
            Some(expected_last.as_str())
        );
    }

    #[test]
    fn clear_diagnostic_interface_state_clears_payload_and_run_metadata() {
        let mut diag = DiagnosticState::default();
        parse_log_into_state(
            r#"2026-04-16T17:40:08-0600 [45230110]# cellular-check
Testing Cellular...
Done: Failure: -65554: Network technology is not connected
"#,
            &mut diag,
        );
        diag.interface_runs.insert(
            "cellular".to_string(),
            InterfaceRunState {
                in_progress: false,
                started_at: Some("12:34:56".into()),
                completed_at: Some("12:35:10".into()),
                last_marker: Some("===== cellular diagnostics end =====".into()),
            },
        );

        clear_diagnostic_interface_state(&mut diag, "cellular");

        assert!(diag.cellular.is_none());
        assert!(!diag.interface_runs.contains_key("cellular"));
    }

    #[test]
    fn human_size_is_decimal() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(31_914_983_424), "31.9 GB");
    }

    #[test]
    fn parse_sd_progress_and_markers() {
        match parse_sd_line("PROGRESS 1048576 2097152 4096000") {
            Some(SdEvent::Progress {
                comp,
                written,
                rate,
            }) => {
                assert_eq!(comp, 1_048_576);
                assert_eq!(written, 2_097_152);
                assert_eq!(rate, 4_096_000);
            }
            _ => panic!("expected progress"),
        }
        assert!(matches!(parse_sd_line("PHASE writing"), Some(SdEvent::Phase(p)) if p == "writing"));
        assert!(matches!(parse_sd_line("VERIFY_OK"), Some(SdEvent::Verified)));
        assert!(matches!(parse_sd_line("FLASH_EXIT 0"), Some(SdEvent::Exit(0))));
        assert!(matches!(parse_sd_line("FLASH_EXIT 130"), Some(SdEvent::Exit(130))));
        assert!(matches!(parse_sd_line("VERIFY_FAIL"), Some(SdEvent::Failure(_))));
        assert!(matches!(parse_sd_line("some raw output"), Some(SdEvent::Log(_))));
        assert!(parse_sd_line("   ").is_none());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_diskutil_info_accepts_external_sd() {
        let text = "\
   Device Identifier:         disk6
   Device Node:               /dev/disk6
   Media Name:                USB SD Reader Media
   Protocol:                  USB
   Removable Media:           Removable
   Internal:                  No
   Virtual:                   No
   Disk Size:                 31.9 GB (31914983424 Bytes) (exactly 62333952 512-Byte-Units)
";
        let t = parse_diskutil_info(text).expect("should parse an external SD card");
        assert_eq!(t.id, "disk6");
        assert_eq!(t.name, "USB SD Reader Media");
        assert_eq!(t.size_bytes, 31_914_983_424);
        assert_eq!(t.size_label, "31.9 GB");
        assert!(t.removable);
        assert_eq!(t.bus, "USB");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_diskutil_info_rejects_internal() {
        let text = "\
   Device Identifier:         disk0
   Media Name:                APPLE SSD
   Protocol:                  Apple Fabric
   Removable Media:           Fixed
   Internal:                  Yes
   Virtual:                   No
   Disk Size:                 994.7 GB (994662584320 Bytes)
";
        assert!(parse_diskutil_info(text).is_none());
    }

}
