use serialport::SerialPort;
#[cfg(target_os = "windows")]
use serialport::SerialPortType;
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "windows")]
use std::io::ErrorKind as IoErrorKind;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

mod parsers;

use parsers::parse_log_into_state;

const VPN_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const VPN_STOP_TIMEOUT: Duration = Duration::from_secs(8);
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
    windows_local_serial_writer: Option<Arc<Mutex<Box<dyn SerialPort>>>>,
    windows_local_serial_kill: Option<Arc<AtomicBool>>,
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

#[derive(serde::Serialize, serde::Deserialize, Clone, Default, PartialEq)]
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

// ── Commands ──────────────────────────────────────────────────────────────────

fn log_file_path(ip: &str) -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let filename = format!("fwds-{}-{}.txt", ip, date);
    dirs::desktop_dir()
        .unwrap_or_else(|| PathBuf::from("~/Desktop"))
        .join(filename)
}

fn local_serial_log_file(device: &str) -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let safe = device
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let filename = format!("fwds-serial-{}-{}.txt", safe, date);
    dirs::desktop_dir()
        .unwrap_or_else(|| PathBuf::from("~/Desktop"))
        .join(filename)
}

#[cfg(target_os = "windows")]
fn append_windows_transcript(device: &str, line: &str) {
    let log_path = local_serial_log_file(device);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

#[cfg(target_os = "windows")]
fn open_windows_transcript_terminal(log_path: &Path) -> Result<(), String> {
    let path = log_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$p='{path}'; if (!(Test-Path -LiteralPath $p)) {{ New-Item -ItemType File -Path $p -Force | Out-Null }}; \
         Write-Host 'FWDS local serial session (live transcript)' -ForegroundColor Cyan; \
         Write-Host ('Log: ' + $p) -ForegroundColor DarkGray; \
         Get-Content -LiteralPath $p -Wait"
    );
    Command::new("cmd")
        .args([
            "/C",
            "start",
            "FWDS Local Session",
            "powershell",
            "-NoExit",
            "-Command",
            &script,
        ])
        .spawn()
        .map_err(|e| format!("Failed to open terminal window: {e}"))?;
    Ok(())
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

    // Spawn SSH directly — no connect.bin, no verbose flags, UserKnownHostsFile=/dev/null
    // avoids host-key conflicts when controllers are replaced.
    // -tt forces PTY on remote so prompts work and echo behaves correctly.
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
            "ServerAliveInterval=15",
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
    if inner.connection_mode == "local" {
        if let Some(writer) = inner.windows_local_serial_writer.as_ref() {
            if let Some(device) = inner.local_serial_device.as_deref() {
                append_windows_transcript(device, "^C");
            }
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
        (true, true) => format!("{ip} reachable, port 22 open"),
        (true, false) => format!("{ip} reachable but port 22 closed"),
        (false, true) => format!("{ip} ping failed, port 22 open"),
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
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        inner.connection_mode = "vpn".into();
        inner.local_serial_device = None;
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

    // Resolve HOME and date in Rust so the path is fully expanded before quoting.
    // shell_quote wraps in single quotes which would prevent $HOME/$(date) from expanding.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let date_str = Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "session".into());
    let log_path = format!("{}/Desktop/fwds-{}-{}.txt", home, ip, date_str);
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
        }
        start_log_watcher_internal(&state, false)?;
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

#[tauri::command]
fn open_local_serial_terminal(device: String, state: State<'_, AppState>) -> Result<(), String> {
    if device.trim().is_empty() {
        return Err("Serial device is required".into());
    }

    #[cfg(target_os = "windows")]
    {
        let com_port = normalize_windows_com_label(&device);
        let log_path = local_serial_log_file(&com_port);
        {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner.connection_mode = "local".into();
            inner.local_serial_device = Some(com_port.clone());
            inner.shell_phase = "connecting".into();
            inner.shell_detail = format!("Opening {com_port} at 115200…");
            inner.external_terminal_window_id = None;
            if let Some(kill) = inner.windows_local_serial_kill.take() {
                kill.store(true, Ordering::Relaxed);
            }
            inner.windows_local_serial_writer = None;
        }

        let writer = serialport::new(&com_port, 115_200)
            .timeout(Duration::from_millis(200))
            .open()
            .map_err(|e| map_serial_open_error(&e))?;

        let reader = writer
            .try_clone()
            .map_err(|e| format!("Failed to clone serial handle: {e}"))?;
        let writer_arc = Arc::new(Mutex::new(writer));
        let kill_flag = Arc::new(AtomicBool::new(false));
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
        open_windows_transcript_terminal(&log_path)?;

        {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner.windows_local_serial_writer = Some(writer_arc);
            inner.windows_local_serial_kill = Some(kill_flag.clone());
            inner.shell_phase = "connected".into();
            inner.shell_detail = format!("Connected to {com_port} @ 115200");
            inner
                .shell_logs
                .push(format!("[Serial connected] {com_port} @ 115200"));
        }

        let arc = state.inner.clone();
        thread::spawn(move || {
            let mut port = reader;
            let mut buf = [0u8; 2048];
            let mut partial = String::new();
            let mut transcript = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();

            while !kill_flag.load(Ordering::Relaxed) {
                match port.read(&mut buf) {
                    Ok(0) => continue,
                    Ok(n) => {
                        let chunk = normalize_chunk(&String::from_utf8_lossy(&buf[..n]));
                        if let Some(f) = transcript.as_mut() {
                            let _ = f.write_all(chunk.as_bytes());
                            let _ = f.flush();
                        }
                        partial.push_str(&chunk);
                        while let Some(pos) = partial.find('\n') {
                            let line = partial[..pos].to_string();
                            partial = partial[pos + 1..].to_string();
                            if let Ok(mut inner) = arc.lock() {
                                if !line.is_empty() {
                                    inner.shell_logs.push(line);
                                }
                            }
                        }
                    }
                    Err(e) if e.kind() == IoErrorKind::TimedOut => continue,
                    Err(e) => {
                        if let Some(f) = transcript.as_mut() {
                            let _ = writeln!(f, "\n[serial-disconnected] {e}");
                            let _ = f.flush();
                        }
                        if let Ok(mut inner) = arc.lock() {
                            inner.shell_phase = "failed".into();
                            inner.shell_detail = format!("Serial device disconnected: {e}");
                            inner.shell_logs.push(format!("[Serial disconnected] {e}"));
                            inner.windows_local_serial_writer = None;
                            inner.windows_local_serial_kill = None;
                        }
                        return;
                    }
                }
            }

            if !partial.trim().is_empty() {
                if let Ok(mut inner) = arc.lock() {
                    inner
                        .shell_logs
                        .push(partial.trim_end_matches('\n').to_string());
                }
            }
        });

        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        {
            let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner.connection_mode = "local".into();
            inner.local_serial_device = Some(device.clone());
        }

        let log_path = local_serial_log_file(&device);
        let command = format!(
            "clear; script -q {} minicom -D {} -b 115200; exit",
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
            }
            start_log_watcher_internal(&state, false)?;
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
}

#[tauri::command]
fn disconnect_local_controller(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
        if let Some(device) = inner.local_serial_device.clone() {
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
        if let Some(kill) = inner.windows_local_serial_kill.take() {
            kill.store(true, Ordering::Relaxed);
        }
        inner.windows_local_serial_writer = None;
        inner.local_serial_device = None;
        inner.connection_mode = "local".into();
        inner.external_terminal_window_id = None;
        inner.shell_phase = "disconnected".into();
        inner.shell_detail = "Local session disconnected".into();
        inner.shell_logs.push("[Local disconnected]".into());
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
        let (writer_arc, local_device) = {
            let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            if inner.connection_mode != "local" {
                (None, None)
            } else {
                (
                    inner.windows_local_serial_writer.clone(),
                    inner.local_serial_device.clone(),
                )
            }
        };
        if let Some(writer_arc) = writer_arc {
            let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            let mut writer = writer_arc.lock().map_err(|_| "serial lock poisoned")?;
            if normalized.is_empty() {
                if let Some(device) = local_device.as_deref() {
                    append_windows_transcript(device, ">");
                }
                writer
                    .write_all(b"\r\n")
                    .map_err(|e| format!("Failed to send command: {e}"))?;
            } else {
                for line in normalized.split('\n') {
                    if let Some(device) = local_device.as_deref() {
                        append_windows_transcript(device, &format!("> {line}"));
                    }
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
        } else {
            return Err("Session not open".into());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let window_id = {
            let inner = state.inner.lock().map_err(|_| "state lock poisoned")?;
            inner
                .external_terminal_window_id
                .ok_or_else(|| "Open session first".to_string())?
        };

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

    if let (Ok(mut diag), Ok(store)) =
        (state.diagnostic_state.lock(), state.diagnostic_store.lock())
    {
        if let Some(cached) = store.controllers.get(&controller_key) {
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
                    if let Ok(mut diag) = diag_arc.lock() {
                        parse_log_into_state(&buffer, &mut diag);
                        diag.last_updated =
                            Some(chrono::Local::now().format("%H:%M:%S").to_string());
                        diag.session_has_data = has_any_diag_data(&diag);

                        // Notify frontend immediately when SID first appears in the log.
                        let current_sid = diag.system.as_ref().and_then(|s| s.sid.clone());
                        if prev_sid.is_none() && current_sid.is_some() {
                            if let Ok(h) = app_handle_arc.lock() {
                                if let Some(handle) = h.as_ref() {
                                    let _ =
                                        handle.emit("controller-sid-detected", current_sid.clone());
                                }
                            }
                        }
                        prev_sid = current_sid;

                        // Notify frontend whenever system diagnostic data changes so that
                        // the System Configuration tab refreshes without waiting for its
                        // 2-second poll cycle.
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
                        if current_system_sig != prev_system_sig && !current_system_sig.is_empty() {
                            if let Ok(h) = app_handle_arc.lock() {
                                if let Some(handle) = h.as_ref() {
                                    let _ = handle.emit("system-config-updated", ());
                                }
                            }
                        }
                        prev_system_sig = current_system_sig;

                        let mut migrated_from: Option<String> = None;
                        if let Some(sid) = diag
                            .system
                            .as_ref()
                            .and_then(|system| system.sid.as_ref())
                            .map(|sid| sid.trim())
                            .filter(|sid| !sid.is_empty())
                        {
                            let sid_key = format!("vpn:{sid}");
                            if sid_key != active_controller_key {
                                migrated_from = Some(active_controller_key.clone());
                                active_controller_key = sid_key.clone();
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

#[tauri::command]
fn clear_diagnostic_interface(state: State<'_, AppState>, interface: String) -> Result<(), String> {
    let mut diag = state.diagnostic_state.lock().map_err(|_| "lock poisoned")?;
    match interface.as_str() {
        "wifi" => diag.wifi = None,
        "cellular" => diag.cellular = None,
        "satellite" => diag.satellite = None,
        "ethernet" => diag.ethernet = None,
        "pressure" => diag.pressure = None,
        "sim_picker" => diag.sim_picker = None,
        "system" => diag.system = None,
        _ => {}
    }
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
    with_vpn_state(inner_state, transition_token, |inner| {
        inner.managed_openvpn_pid = None;
        inner.managed_openvpn_log_path = None;
        inner.managed_openvpn_log_offset = 0;
        cleanup_stage_dir(inner.managed_openvpn_stage_dir.take());
        inner.vpn_cancel_requested = false;
    })?;

    let stage_dir = stage_bundle(folder)?;
    let staged_config = stage_dir.join("ovpn.conf");
    let log_path = vpn_log_path();
    let openvpn_binary = resolve_openvpn()?;
    let launcher = write_launcher_script(&stage_dir, &staged_config, &log_path, &openvpn_binary)?;
    let pid = launch_openvpn_elevated(&launcher, &[])?;

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
    matches!(phase, "disconnected" | "failed" | "unknown")
}

fn can_stop_from(phase: &str) -> bool {
    matches!(phase, "connected" | "starting")
}

fn stage_bundle(folder_path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(folder_path);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stage_dir = PathBuf::from(format!("/private/tmp/fwds-vpn-stage-{ts}"));

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

fn stop_openvpn_pids_force_elevated(pids: &[u32]) -> Result<(), String> {
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

// ── App setup ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut initial_inner = InnerState::default();
    initial_inner.vpn_phase = "disconnected".into();
    initial_inner.shell_phase = "disconnected".into();
    initial_inner.connection_mode = "vpn".into();

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
            open_controller_terminal,
            list_serial_devices,
            open_local_serial_terminal,
            disconnect_local_controller,
            get_app_state,
            start_log_watcher,
            get_diagnostic_state,
            clear_diagnostic_state,
            clear_diagnostic_interface,
            stop_log_watcher,
            quit_app,
        ])
        .setup(|app| {
            let state: tauri::State<AppState> = app.state();
            if let Ok(mut h) = state.app_handle.lock() {
                *h = Some(app.handle().clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
