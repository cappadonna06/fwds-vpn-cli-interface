import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DIAGNOSTIC_BLOCKS, DiagnosticBlock, COMMANDS } from "../../types/commands";
import { sendCommandText } from "../../lib/commandActions";

type DiagStatus = "grey" | "green" | "orange" | "red" | "unknown";
type HealthTone = "healthy" | "warning" | "error" | "neutral";
type GlobalDiagTier = "quick" | "full" | "no-satellite";

const GLOBAL_DIAG_MODES: Record<GlobalDiagTier, {
  label: string;
  blockId: string;
  tooltipTitle: string;
  summary: string;
  eta: string;
}> = {
  quick: {
    label: "Quick",
    blockId: "networking-all",
    tooltipTitle: "Quick diagnostics",
    summary: "Ethernet, Wi-Fi, cellular, and satellite basic checks. Skips the satellite loopback test.",
    eta: "~1-2 minutes",
  },
  full: {
    label: "Full",
    blockId: "full-diags",
    tooltipTitle: "Full diagnostics",
    summary: "All network diagnostics, satellite loopback, pressure readings, and system configuration checks.",
    eta: "~10-12 minutes",
  },
  "no-satellite": {
    label: "Full (No Loopback)",
    blockId: "full-diags-no-sat",
    tooltipTitle: "Full diagnostics without loopback",
    summary: "Full diagnostics with satellite basic checks, pressure readings, and system configuration. Skips the long satellite loopback test.",
    eta: "~2-3 minutes",
  },
};

interface WifiDiagnostic {
  status: DiagStatus;
  summary: string;
  check_result: string;
  check_error?: string | null;
  internet_reachable: boolean;
  wifi_state: string;
  access_point?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  check_avg_latency_ms?: number | null;
  check_packet_loss_pct: number;
  signal_dbm?: number | null;
  signal_dbm_trusted: boolean;
  interface_exists: boolean;
  interface_name?: string | null;
  interface_type?: string | null;
  mac_address?: string | null;
  ssid?: string | null;
  tx_power_dbm?: number | null;
  connected?: boolean | null;
  ap_bssid?: string | null;
  frequency_mhz?: number | null;
  tx_bitrate_mbps?: number | null;
  station_tx_retries?: number | null;
  station_tx_failed?: number | null;
  station_tx_bitrate_mbps?: number | null;
  lower_up_flag?: boolean | null;
  link_state?: string | null;
  ipv4_address?: string | null;
  ipv4_prefix?: number | null;
  default_via_wlan0?: boolean | null;
  default_gateway?: string | null;
  connman_wifi_powered?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_active_service?: string | null;
  connman_wifi_active?: boolean | null;
  connman_state?: string | null;
  driver?: string | null;
  proc_rx_bytes?: number | null;
  proc_rx_packets?: number | null;
  proc_rx_drop?: number | null;
  proc_tx_bytes?: number | null;
  proc_tx_packets?: number | null;
}

interface CopsNetwork {
  stat: number;
  long_name: string;
  numeric: string;
  act: number;
  resolved_name: string;
}

interface CellularDiagnostic {
  status: DiagStatus;
  summary: string;
  check_result: string;
  check_error?: string | null;
  internet_reachable: boolean;
  cell_state: string;
  provider_code?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  check_avg_latency_ms?: number | null;
  check_packet_loss_pct: number;
  imei?: string | null;
  iccid?: string | null;
  imsi?: string | null;
  hni?: string | null;
  basic_provider?: string | null;
  basic_status?: string | null;
  basic_signal?: string | null;
  basic_apn?: string | null;
  connman_cell_powered?: boolean | null;
  connman_cell_connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_eth_connected?: boolean | null;
  connman_active_service?: string | null;
  connman_cell_active?: boolean | null;
  connman_cell_ready?: boolean | null;
  connman_state?: string | null;
  wwan_ipv4_address?: string | null;
  wwan_ipv4_prefix?: number | null;
  role?: string | null;
  modem_present?: boolean | null;
  modem_model?: string | null;
  sim_ready?: boolean | null;
  sim_inserted?: boolean | null;
  operator_name?: string | null;
  qcsq?: string | null;
  rssi_dbm?: number | null;
  rat?: string | null;
  mccmnc?: string | null;
  band?: string | null;
  at_apn?: string | null;
  recommended_action?: string | null;
  other_actions?: string[] | null;
  full_block_run?: boolean;
  modem_not_present?: boolean;
  modem_unreachable?: boolean;
  setup_attempted?: boolean;
  setup_timed_out?: boolean;
  cellular_disabled?: boolean;
  no_service?: boolean;
  sim_present?: boolean;
}

interface SatelliteDiagnostic {
  status: DiagStatus;
  summary: string;
  satellite_state?: string | null;
  controller_sid?: string | null;
  controller_version?: string | null;
  controller_date?: string | null;
  sat_imei?: string | null;
  modem_present?: boolean | null;
  connman_state?: string | null;
  connman_eth_connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_cell_connected?: boolean | null;
  connman_active_service?: string | null;
  default_gateway?: string | null;
  default_via_eth0?: boolean | null;
  default_via_wlan0?: boolean | null;
  default_via_wwan0?: boolean | null;
  satellites_seen?: number | null;
  light_test_ran: boolean;
  light_test_success?: boolean | null;
  light_test_timeout?: boolean | null;
  light_test_blocked_in_use?: boolean | null;
  light_test_error?: string | null;
  loopback_test_ran: boolean;
  loopback_test_success?: boolean | null;
  loopback_test_timeout?: boolean | null;
  loopback_test_blocked_in_use?: boolean | null;
  loopback_test_error?: string | null;
  station_sent_epoch?: number | null;
  server_sent_epoch?: number | null;
  current_epoch?: number | null;
  total_time_seconds?: number | null;
  loopback_duration_seconds?: number | null;
  loopback_packet_loss_pct?: number | null;
  recommended_action?: string | null;
  other_actions?: string[] | null;
}

interface EthernetDiagnostic {
  status: DiagStatus;
  summary: string;
  technology_disabled?: boolean;
  internet_reachable: boolean;
  eth_state: string;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  ip_address?: string | null;
  netmask?: string | null;
  speed?: string | null;
  duplex?: string | null;
  link_detected?: boolean | null;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  check_result: string;
  flap_count: number;
  full_block_run?: boolean;
  ethernet_diag_attempted?: boolean;
}

interface PressureSensorReading {
  name: string;
  index: number;
  snapshot: number;
  latest: number;
  mean: number;
  min: number;
  max: number;
  stdev: number;
  count: number;
  voltage?: number | null;
}

interface PressureIssue {
  id: string;
  severity: DiagStatus;
  title: string;
  description: string;
  action: string;
}

interface PressureDiagnostic {
  status: DiagStatus;
  summary: string;
  via_sensor?: string | null;
  display_psi?: number | null;
  controller_id?: string | null;
  fw_version?: string | null;
  system_type?: string | null;
  is_active?: boolean;
  sensors: {
    source?: PressureSensorReading | null;
    distribution?: PressureSensorReading | null;
    supply?: PressureSensorReading | null;
  };
  sensor_errors: Array<{ sensor_index: number; message: string; errno: number }>;
  asserts: Array<{ file: string; line: number }>;
  issues: PressureIssue[];
}

interface SystemDiagnostic {
  sid?: string | null;
  version?: string | null;
  controller_date?: string | null;
  release_date?: string | null;
  preferred_network?: string | null;
  system_type?: string | null;
}

type SimPickerRecommendation =
  | "NotRun"
  | "ScanFailed"
  | "DeadZone"
  | "KeepCurrent"
  | "WeakButBest"
  | { SwapTo: string };

interface SimPickerDiagnostic {
  scan_attempted: boolean;
  scan_completed: boolean;
  scan_failed: boolean;
  scan_empty: boolean;
  full_block_run: boolean;
  installed_iccid?: string | null;
  installed_imsi?: string | null;
  installed_carrier_code?: string | null;
  installed_carrier_name?: string | null;
  detected_networks: CopsNetwork[];
  nwscanmode?: number | null;
  best_network_code?: string | null;
  best_network_name?: string | null;
  installed_carrier_detected: boolean;
  current_registered_code?: string | null;
  recommendation: SimPickerRecommendation;
  recommendation_detail: string;
  qcsq_rsrp?: number | null;
  last_updated?: string | null;
}

interface DiagnosticState {
  wifi?: WifiDiagnostic | null;
  cellular?: CellularDiagnostic | null;
  satellite?: SatelliteDiagnostic | null;
  ethernet?: EthernetDiagnostic | null;
  pressure?: PressureDiagnostic | null;
  system?: SystemDiagnostic | null;
  sim_picker?: SimPickerDiagnostic | null;
  interface_runs?: Partial<Record<InterfaceKey, InterfaceRunState>>;
  last_updated?: string | null;
  session_has_data?: boolean;
}
interface InterfaceRunState {
  in_progress: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  last_marker?: string | null;
}

type DiagRow = { label: string; value: string };
type DiagSection = { title: string; rows: DiagRow[] };

interface DiagCardProps {
  title: string;
  icon: string;
  health: HealthTone;
  statusLabel: string;
  primaryTags?: string[];
  primaryLine: string;
  secondaryLine?: string | null;
  secondaryTags?: string[];
  role?: string | null;
  signalLabel?: string | null;
  signalScore?: number | null;
  sections: DiagSection[];
  updatedAt?: string | null;
  expanded: boolean;
  onToggle: () => void;
  onCopyCommand?: () => void;
  copied?: boolean;
  onSendCommand?: () => void;
  sent?: boolean;
  compact?: boolean;
  emphasizeSecondaryLine?: boolean;
  onClear?: () => void;
  updating?: boolean;
  onForceRelease?: () => void;
  countdown?: CountdownProps;
  collapsedMetricCards?: Array<{ label: string; value: string; tone: HealthTone }>;
  inlineControls?: ReactNode;
}

type InterfaceKey = "wifi" | "cellular" | "satellite" | "ethernet" | "pressure" | "sim_picker";
type HoldState = {
  startedAt: number;
  expiresAt: number;
  reason: string;
  inProgressConfirmed?: boolean;
  // Snapshot of pressure sensor counts at hold-creation time so we can require
  // NEW readings (counts beyond baseline) before releasing the pressure hold.
  pressureBaselineCounts?: { source: number; distribution: number; supply: number };
  // Baseline satellite IMEI at hold-creation time; release early when IMEI
  // arrives or changes (handles fast-complete without an in_progress transition).
  satelliteBaselineImei?: string | null;
};

function resolveBlockScript(block: DiagnosticBlock, tier: "light" | "heavy"): string {
  const custom = tier === "light" ? block.light_script : block.heavy_script;
  if (custom && custom.trim().length > 0) return custom;
  const ids = tier === "light" ? block.light_command_ids : block.heavy_command_ids;
  return ids.map((id) => COMMANDS.find((c) => c.id === id)?.command ?? id).join("\n");
}

function inferInterfacesFromScript(script: string): InterfaceKey[] {
  const lower = script.toLowerCase();
  const interfaces = new Set<InterfaceKey>();
  if (lower.includes("wifi-check") || lower.includes("wifi-signal")) interfaces.add("wifi");
  if (lower.includes("cellular-check") || lower.includes("cell-")) interfaces.add("cellular");
  if (lower.includes("satellite-check") || lower.includes("sat-imei")) interfaces.add("satellite");
  if (lower.includes("ethernet-check") || lower.includes("ethtool eth0")) interfaces.add("ethernet");
  if (lower.includes("pressure-monitor")) interfaces.add("pressure");
  if (lower.includes("sim picker") || lower.includes("cell-support --no-ofono --at --scan")) interfaces.add("sim_picker");
  return [...interfaces];
}

function interfacesForBlock(block: DiagnosticBlock, script: string): InterfaceKey[] {
  const fromMetadata = (block.affected_interfaces ?? [])
    .filter((iface): iface is InterfaceKey => iface !== "system");
  if (fromMetadata.length > 0) return fromMetadata;
  console.warn(`[Diagnostics] affected_interfaces missing for block "${block.id}", using script inference fallback.`);
  return inferInterfacesFromScript(script);
}

// Backend stores started_at as "%H:%M:%S" (local time, no date). JavaScript's
// Date constructor can't parse a bare time string, so we reconstruct today's date.
function parseBackendTime(timeStr?: string | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(":");
  if (parts.length < 3) return null;
  const d = new Date();
  d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10), 0);
  const ms = d.getTime();
  return isNaN(ms) ? null : ms;
}

function isInterfaceComplete(iface: InterfaceKey, state: DiagnosticState | null | undefined): boolean {
  if (!state) return false;
  if (iface === "wifi") {
    return state.interface_runs?.wifi?.in_progress === false
      && state.interface_runs?.wifi?.started_at !== undefined;
  }
  if (iface === "ethernet") {
    return state.interface_runs?.ethernet?.in_progress === false
      && state.interface_runs?.ethernet?.started_at !== undefined;
  }
  if (iface === "cellular") {
    return state.interface_runs?.cellular?.in_progress === false
      && state.interface_runs?.cellular?.started_at !== undefined;
  }
  if (iface === "sim_picker") {
    return !!state.sim_picker && state.sim_picker.scan_attempted && (
      state.sim_picker.scan_completed
      || state.sim_picker.scan_failed
      || state.sim_picker.scan_empty
    );
  }
  if (iface === "satellite") {
    return state.interface_runs?.satellite?.in_progress === false
      && state.interface_runs?.satellite?.started_at !== undefined;
  }
  if (iface === "pressure") {
    const p = state.pressure;
    if (!p) return false;
    const readings = [p.sensors?.source, p.sensors?.distribution, p.sensors?.supply].filter(Boolean);
    return readings.some((sensor) => (sensor?.count ?? 0) > 0) || (p.sensor_errors?.length ?? 0) > 0;
  }
  return false;
}

// Returns true only when pressure has NEW sensor counts beyond the baseline that
// was snapshotted when the hold was created, preventing premature release due to
// leftover readings from a prior session satisfying isInterfaceComplete.
function isPressureCompleteVsBaseline(
  state: DiagnosticState | null | undefined,
  baseline?: { source: number; distribution: number; supply: number },
): boolean {
  const p = state?.pressure;
  if (!p) return false;
  const src  = p.sensors?.source?.count       ?? 0;
  const dist = p.sensors?.distribution?.count ?? 0;
  const sup  = p.sensors?.supply?.count       ?? 0;
  if (!baseline) return src > 0 || dist > 0 || sup > 0;
  return src > baseline.source || dist > baseline.distribution || sup > baseline.supply;
}

function holdTimeoutMsForInterface(iface: InterfaceKey, script: string): number {
  const lower = script.toLowerCase();
  const hasSatelliteLoopback = lower.includes("satellite-check -t");
  if (iface === "satellite" && hasSatelliteLoopback) return 15 * 60 * 1000;
  return 60 * 1000;
}

// ── Progress countdown ─────────────────────────────────────────────────────

// Expected wall-clock time for each interface's own diagnostic commands.
// Sequential blocks (full-diags) stack these cumulatively so that each card's
// countdown starts at the right offset from the moment the command is sent.
const IFACE_DURATION_MS: Record<InterfaceKey, number> = {
  ethernet:   12_000,   // ~10–15 s in practice
  wifi:       15_000,   // ~12–18 s
  cellular:   20_000,   // ~15–25 s (IMEI + signal + check)
  pressure:   35_000,   // ~25–40 s (snapshot + live readings)
  sim_picker: 180_000,
  satellite:  10_000,   // quick non-loopback check (~5–10 s); loopback overridden below
};

function ifaceDurationMs(iface: InterfaceKey, script: string): number {
  if (iface === "satellite" && script.toLowerCase().includes("satellite-check -t"))
    return 15 * 60 * 1000;
  return IFACE_DURATION_MS[iface] ?? 60_000;
}

type CountdownProps = {
  progressFraction: number;
  remainingMs: number;
  elapsedMs: number;
  isElapsedMode: boolean; // satellite loopback: show elapsed rather than remaining
};

function fmtCountdownMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
}

function ProgressCountdown({ progressFraction, remainingMs, elapsedMs, isElapsedMode }: CountdownProps) {
  const r    = 11;
  const circ = 2 * Math.PI * r;
  const done = progressFraction >= 1 || remainingMs === 0;
  const offset = done ? 0 : circ * (1 - progressFraction);
  const label  = done
    ? "Done"
    : isElapsedMode
    ? `${fmtCountdownMs(elapsedMs)} elapsed`
    : fmtCountdownMs(remainingMs);

  return (
    <span className="diag-progress-countdown">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="diag-progress-ring">
        <circle cx="13" cy="13" r={r} fill="none" strokeWidth="2.5"
                className="diag-progress-ring-track" />
        <circle cx="13" cy="13" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={offset}
                transform="rotate(-90 13 13)"
                className={`diag-progress-ring-fill${done ? " done" : ""}`} />
      </svg>
      <span className="diag-progress-label">{label}</span>
    </span>
  );
}

function toneFromStatus(status?: DiagStatus | null): HealthTone {
  if (status === "green") return "healthy";
  if (status === "orange") return "warning";
  if (status === "red") return "error";
  return "neutral";
}

function speedLabel(speed?: string | null): string {
  if (!speed) return "Unknown speed";
  const s = speed.toLowerCase();
  if (s.includes("1000")) return "Gigabit";
  if (s.includes("100")) return "Fast Ethernet";
  return speed;
}

const ALL_CARRIERS = [
  { name: "AT&T",     codes: ["310410","310380","310980","311180","310030","310560","310680"] },
  { name: "T-Mobile", codes: ["310260","310026","310490","310660","312250","310230","310240","310250"] },
  { name: "Verizon",  codes: ["311270","311271","311272","311273","311274","311275","311276","311277",
                               "311278","311279","311280","311480","311481","311482","311483","311484",
                               "311485","311486","311487","311488","311489"] },
];

function simPickerHealth(sp?: SimPickerDiagnostic | null): HealthTone {
  if (!sp) return "neutral";
  if (!sp.scan_attempted) return "neutral";
  if (sp.scan_empty || sp.recommendation === "DeadZone") return "error";
  const rec = sp.recommendation;
  if (typeof rec === "string") {
    if (rec === "NotRun") return "neutral";
    if (rec === "ScanFailed" || rec === "WeakButBest") return "warning";
    if (rec === "KeepCurrent") return "healthy";
  }
  // SwapTo => installed SIM is not best fit here
  return "warning";
}

function simPickerBadge(sp?: SimPickerDiagnostic | null): string {
  const tone = simPickerHealth(sp);
  if (tone === "healthy") return "Healthy";
  if (tone === "warning") return "Warning";
  if (tone === "error") return "Error";
  return "Not run";
}

function stripLeadingWarningIcon(value: string): string {
  return value.replace(/^(?:\s*(?:⚠️|⚠|△)\s*)+/, "").trim();
}

function simPickerPrimary(sp?: SimPickerDiagnostic | null): string {
  if (!sp || !sp.scan_attempted) return "Check which carrier has coverage here";
  if (sp.scan_failed) return "Network scan failed";
  if (sp.scan_empty) return "No carriers detected";
  const rec = sp.recommendation;
  if (typeof rec === "object" && "SwapTo" in rec) {
    return sp.installed_carrier_detected
      ? `${sp.installed_carrier_name ?? "Installed"} weak · Install ${rec.SwapTo} SIM`
      : `${sp.installed_carrier_name ?? "Installed"} not detected · Install ${rec.SwapTo} SIM`;
  }
  if (rec === "KeepCurrent") {
    return `${sp.installed_carrier_name ?? "Installed"} · Keep current SIM`;
  }
  return sp.recommendation_detail || "Scan complete";
}

function simPickerSecondary(sp?: SimPickerDiagnostic | null): string | null {
  if (!sp || !sp.scan_attempted) return "Copy the command block, run in terminal, then return here.";
  if (!sp.recommendation_detail) return null;
  return sp.recommendation_detail;
}

function buildSimPickerSections(sp?: SimPickerDiagnostic | null): DiagSection[] {
  if (!sp || !sp.scan_attempted) {
    return [{ title: "Status", rows: [{ label: "Scan", value: "Not run" }] }];
  }

  const rows: DiagRow[] = [];

  if (sp.scan_failed) {
    rows.push({ label: "Scan", value: "Failed" });
    if (sp.nwscanmode === 1) rows.push({ label: "Note", value: "Modem in LTE-only mode — run setup-cellular to reset" });
    return [{ title: "Scan", rows }];
  }

  if (sp.scan_empty) {
    rows.push({ label: "Result", value: "No carriers detected" });
    rows.push({ label: "Next step", value: "Check antenna placement and sky view" });
    return [{ title: "Scan", rows }];
  }

  // Carrier list: show all three major carriers
  const networkRows: DiagRow[] = ALL_CARRIERS.map(carrier => {
    const detected = sp.detected_networks.find(n => carrier.codes.includes(n.numeric));
    const label = detected
      ? (detected.stat === 1 ? "Available" : detected.stat === 2 ? "Connected" : "Detected")
      : "Not seen";
    return { label: carrier.name, value: label };
  });

  // Show FirstNet if detected, marked as restricted
  const firstNet = sp.detected_networks.find(n => n.numeric === "313100");
  if (firstNet) {
    networkRows.push({ label: "FirstNet (AT&T)", value: "Detected — restricted" });
  }

  const installedRows: DiagRow[] = [
    { label: "Installed SIM", value: sp.installed_carrier_name ?? sp.installed_carrier_code ?? "Unknown" },
    { label: "Installed detected", value: sp.installed_carrier_detected ? "Yes" : "No" },
  ];
  if (sp.best_network_name) {
    installedRows.push({ label: "Recommended", value: `Install ${sp.best_network_name} SIM` });
  }

  return [
    { title: "Carriers scanned", rows: networkRows },
    { title: "Recommendation", rows: installedRows },
  ];
}

function signalLabel(score?: number | null): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "No service";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Good";
  if (score >= 25) return "Fair";
  if (score > 0) return "Weak";
  return "No service";
}

function signalLabelFromDbm(dbm?: number | null): string | null {
  if (dbm === null || dbm === undefined || Number.isNaN(dbm)) return null;
  if (dbm >= -60) return "Strong";
  if (dbm >= -67) return "Good";
  if (dbm >= -72) return "Fair";
  if (dbm >= -80) return "Weak";
  return "Poor";
}

function wifiHasAuthoritativeCheck(wifi?: WifiDiagnostic | null): boolean {
  return !!wifi && (wifi.check_result !== "Unknown" || !!wifi.check_error);
}

function wifiCheckConnected(wifi?: WifiDiagnostic | null): boolean {
  return !!wifi && wifi.check_result === "Success"
    && (wifi.internet_reachable !== false || wifi.wifi_state === "online");
}

function wifiConnectedState(wifi?: WifiDiagnostic | null): boolean {
  if (!wifi) return false;
  if (wifiHasAuthoritativeCheck(wifi)) return wifiCheckConnected(wifi);
  return wifi.connected === true || wifi.connman_wifi_connected === true || wifi.internet_reachable === true;
}

function wifiSignalLabel(wifi?: WifiDiagnostic | null): string {
  if (!wifi) return "No data";
  if (wifi.strength_label && wifi.strength_label.trim()) {
    return wifi.strength_label[0].toUpperCase() + wifi.strength_label.slice(1).toLowerCase();
  }
  if (wifi.strength_score !== null && wifi.strength_score !== undefined && !Number.isNaN(wifi.strength_score)) {
    return signalLabel(wifi.strength_score);
  }
  if (wifiHasAuthoritativeCheck(wifi) && !wifiCheckConnected(wifi)) return "No data";
  if (wifi.signal_dbm !== null && wifi.signal_dbm !== undefined && !Number.isNaN(wifi.signal_dbm)) {
    return signalLabelFromDbm(wifi.signal_dbm) ?? "No data";
  }
  return wifiConnectedState(wifi) ? "No data" : "No service";
}

function wifiSignalDisplay(wifi?: WifiDiagnostic | null): string {
  if (!wifi) return "No data";
  const label = wifiSignalLabel(wifi);
  if (wifi.strength_score !== null && wifi.strength_score !== undefined && !Number.isNaN(wifi.strength_score)) {
    return `${label} (${wifi.strength_score}/100)`;
  }
  if (wifi.signal_dbm !== null && wifi.signal_dbm !== undefined && !Number.isNaN(wifi.signal_dbm)
    && (!wifiHasAuthoritativeCheck(wifi) || wifiCheckConnected(wifi))) {
    return `${label} (${wifi.signal_dbm} dBm)`;
  }
  return label;
}

function roleLabel(role?: string | null): string | null {
  if (!role) return null;
  if (role === "active") return "Active";
  if (role === "backup") return "Backup";
  return "Inactive";
}

function cleanCellValue(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^"+|"+$/g, "").replace(/,+$/, "");
  if (!v) return null;
  // Reject multi-token garbage (/proc/net/dev lines, ICMP output, etc.).
  // Valid cell values (APN, carrier, IMEI, status) are all 1–3 whitespace-separated tokens.
  if (v.split(/\s+/).length > 3) return null;
  const upper = v.toUpperCase();
  if (v === "0.0.0.0" || v === "—" || v === "-") return null;
  if (upper.startsWith("+")) return null;
  if (upper.includes("CGPADDR") || upper.includes("CGACT") || upper.includes("QCSQ")) return null;
  if (upper.startsWith("ERROR")) return null;
  return v;
}

function cleanCellIdentityValue(value?: string | null): string | null {
  const cleaned = cleanCellValue(value);
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();
  if (
    upper === "REGISTERED"
    || upper === "UNREGISTERED"
    || upper === "NOSERVICE"
    || upper === "NO SERVICE"
    || upper === "SEARCHING"
  ) {
    return null;
  }
  if (upper.startsWith("RUNNING AT ")) return null;
  return cleaned;
}

// Resolves 5–6 digit MCC-MNC codes to human carrier names.
// Mirrors the Rust resolve_carrier() function in parsers.rs.
// Non-numeric strings are returned as-is (already a name).
function resolveCarrierCode(code?: string | null): string | null {
  if (!code) return null;
  if (!/^\d{5,6}$/.test(code)) return code;
  const map: Record<string, string> = {
    "311270": "Verizon", "311271": "Verizon", "311272": "Verizon", "311273": "Verizon",
    "311274": "Verizon", "311275": "Verizon", "311276": "Verizon", "311277": "Verizon",
    "311278": "Verizon", "311279": "Verizon", "311280": "Verizon", "311480": "Verizon",
    "311481": "Verizon", "311482": "Verizon", "311483": "Verizon", "311484": "Verizon",
    "311485": "Verizon", "311486": "Verizon", "311487": "Verizon", "311488": "Verizon",
    "311489": "Verizon",
    "310260": "T-Mobile", "310026": "T-Mobile", "310490": "T-Mobile", "310660": "T-Mobile",
    "312250": "T-Mobile", "310230": "T-Mobile", "310240": "T-Mobile", "310250": "T-Mobile",
    "310410": "AT&T", "310380": "AT&T", "310980": "AT&T", "311180": "AT&T",
    "310030": "AT&T", "310560": "AT&T", "310680": "AT&T",
    "313100": "FirstNet (AT&T)",
    "310000": "Dish",
  };
  return map[code] ?? code;
}

function resolveCarrierFromApn(apn?: string | null): string | null {
  if (!apn) return null;
  const normalized = apn.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("vzw") || normalized.includes("vzwinternet")) return "Verizon";
  if (normalized.includes("broadband") || normalized.includes("nxtgenphone") || normalized === "phone") return "AT&T";
  return null;
}

function cellularHasAuthoritativeCheck(cell?: CellularDiagnostic | null): boolean {
  return !!cell && (cell.check_result !== "Unknown" || !!cell.check_error);
}

function cellularCheckConnected(cell?: CellularDiagnostic | null): boolean {
  return !!cell && cell.check_result === "Success"
    && (cell.internet_reachable !== false || cell.cell_state === "ready");
}

function cellularConnectedState(cell?: CellularDiagnostic | null): boolean {
  if (!cell) return false;
  if (cellularHasAuthoritativeCheck(cell)) return cellularCheckConnected(cell);
  return cell.connman_cell_connected === true || cell.internet_reachable === true;
}

function cellularExplicitNoService(cell?: CellularDiagnostic | null): boolean {
  if (!cell) return false;
  if (cellularConnectedState(cell)) return false;
  const checkError = (cell.check_error || "").toLowerCase();
  return cell.no_service === true
    || (cell.qcsq || "").toUpperCase() === "NOSERVICE"
    || checkError.includes("network technology is not connected")
    || checkError.includes("-65554");
}

function cellularCarrierLabel(cell?: CellularDiagnostic | null): string {
  if (!cell) return "Cellular";
  const noService = cellularExplicitNoService(cell);
  const providerCarrier = resolveCarrierCode(cleanCellIdentityValue(cell.provider_code) ?? cell.provider_code ?? null)
    || resolveCarrierCode(cleanCellIdentityValue(cell.operator_name) ?? cell.operator_name ?? null);
  const fallbackCarrier = noService
    ? null
    : resolveCarrierCode(cleanCellIdentityValue(cell.basic_provider) ?? cell.basic_provider ?? null)
      || resolveCarrierCode(cleanCellIdentityValue(cell.mccmnc) ?? cell.mccmnc ?? null);
  const apnCarrier = noService
    ? null
    : resolveCarrierFromApn(cleanCellIdentityValue(cell.at_apn) || cleanCellIdentityValue(cell.basic_apn));
  return providerCarrier || fallbackCarrier || apnCarrier || "Cellular";
}

function cellularSignalLabel(cell?: CellularDiagnostic | null): string {
  if (!cell) return "No data";
  if (cellularExplicitNoService(cell)) return "No service";
  if (cell.strength_label && cell.strength_label.trim()) {
    return cell.strength_label[0].toUpperCase() + cell.strength_label.slice(1).toLowerCase();
  }
  if (cell.strength_score !== null && cell.strength_score !== undefined && !Number.isNaN(cell.strength_score)) {
    return signalLabel(cell.strength_score);
  }
  if (cellularHasAuthoritativeCheck(cell) && !cellularCheckConnected(cell)) return "No data";
  if (cell.rssi_dbm !== null && cell.rssi_dbm !== undefined && !Number.isNaN(cell.rssi_dbm)) {
    return signalLabelFromDbm(cell.rssi_dbm) ?? (cellularConnectedState(cell) ? "No data" : "No service");
  }
  return cellularConnectedState(cell) ? "No data" : "No service";
}

function cellularSignalDisplay(cell?: CellularDiagnostic | null): string {
  if (!cell) return "No data";
  const label = cellularSignalLabel(cell);
  if (cell.strength_score !== null && cell.strength_score !== undefined && !Number.isNaN(cell.strength_score)) {
    return `${label} (${cell.strength_score}/100)`;
  }
  if (cell.rssi_dbm !== null && cell.rssi_dbm !== undefined && !Number.isNaN(cell.rssi_dbm)
    && (!cellularHasAuthoritativeCheck(cell) || cellularCheckConnected(cell))) {
    return `${label} (${cell.rssi_dbm} dBm)`;
  }
  return label;
}

function ethernetHasAuthoritativeCheck(ethernet?: EthernetDiagnostic | null): boolean {
  return !!ethernet && ethernet.check_result !== "Unknown";
}

function ethernetCheckDisabled(ethernet?: EthernetDiagnostic | null): boolean {
  if (!ethernet) return false;
  const lower = (ethernet.check_result || "").toLowerCase();
  return ethernet.technology_disabled === true
    || (lower.startsWith("failure")
      && (lower.includes("-65553") || lower.includes("network technology is not enabled") || lower.includes("not enabled")));
}

function ethernetCheckDisconnected(ethernet?: EthernetDiagnostic | null): boolean {
  if (!ethernet) return false;
  const lower = (ethernet.check_result || "").toLowerCase();
  return lower.startsWith("failure")
    && (lower.includes("-65554") || lower.includes("network technology is not connected"));
}

function ethernetCheckPassed(ethernet?: EthernetDiagnostic | null): boolean {
  return !!ethernet && ethernet.check_result === "Success" && ethernet.internet_reachable === true;
}

function formatLoopback(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const rounded = Math.round(seconds);
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildWifiSections(wifi?: WifiDiagnostic | null): DiagSection[] {
  if (!wifi) return [{ title: "Details", rows: [{ label: "Details", value: "No recent data" }] }];
  const speedMbps = wifi.tx_bitrate_mbps ?? wifi.station_tx_bitrate_mbps;
  const wifiSig = wifiSignalDisplay(wifi);
  const weakByController = (wifi.strength_label || "").toLowerCase() === "weak";
  const connected = wifiConnectedState(wifi);
  const internetTest = wifiHasAuthoritativeCheck(wifi)
    ? (wifi.check_result === "Success" || (connected && wifi.internet_reachable === true))
      ? "Passed"
      : "Failed"
    : connected
      ? "Retest"
      : "Not run";

  const network: DiagRow[] = [
    { label: "Network", value: wifi.access_point || ((wifi.ssid && !wifi.ssid.startsWith('=') ? wifi.ssid : null) || "Unknown") },
    { label: "Connection", value: connected ? "Connected" : "Not connected" },
    { label: "Signal", value: wifiSig },
    { label: "Role", value: wifi.default_via_wlan0 === true ? "Primary" : connected ? "Backup" : "Unknown" },
    { label: "Speed", value: speedMbps !== null && speedMbps !== undefined ? `${speedMbps.toFixed(1)} Mbps` : "—" },
    { label: "Internet test", value: internetTest },
  ];

  const action: DiagRow[] = [];
  const checkErrorLower = (wifi.check_error || "").toLowerCase();
  const notEnabled = checkErrorLower.includes("-65553")
    || checkErrorLower.includes("not enabled")
    || wifi.connman_wifi_powered === false;
  const canRecommendWifiSetup = wifiHasAuthoritativeCheck(wifi)
    ? !wifiCheckConnected(wifi)
    : !connected && !wifi.internet_reachable;
  if (canRecommendWifiSetup && notEnabled) {
    action.push({ label: "Recommended action", value: "Enable Wi-Fi via setup-wifi" });
  } else if (wifi.check_error && canRecommendWifiSetup) {
    if (checkErrorLower.includes("-65554") || checkErrorLower.includes("not connected")) {
      action.push({ label: "Recommended action", value: "Run setup-wifi and verify AP/credentials" });
    } else {
      action.push({ label: "Recommended action", value: "Check passphrase or AP selection" });
    }
  } else if (weakByController || ((wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25)) {
    action.push({ label: "Recommended action", value: "Improve Wi-Fi coverage (move AP closer or add a repeater)" });
  }

  return [
    { title: "Details", rows: network },
    ...(action.length ? [{ title: "Recommended Actions", rows: action }] : []),
  ];
}

function buildCellularSections(cell?: CellularDiagnostic | null): DiagSection[] {
  if (!cell) return [{ title: "Details", rows: [{ label: "Details", value: "No recent data" }] }];
  const connected = cellularConnectedState(cell);
  const noService = cellularExplicitNoService(cell);
  const internetTest = cellularHasAuthoritativeCheck(cell)
    ? (cell.check_result === "Success" || (connected && cell.internet_reachable === true))
      ? "Passed"
      : "Failed"
    : connected
      ? "Retest"
      : "Not run";

  const primaryAction = cell.recommended_action
    || (cell.sim_inserted === false ? "Insert SIM card" : null)
    || (cell.modem_present === false ? "Check modem hardware/firmware" : null)
    || (((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) ? "Check coverage or antenna" : null);

  const heuristicOptions: string[] = [];
  if (cell.sim_inserted === false) heuristicOptions.push("Insert SIM card");
  if (cell.modem_present === false) heuristicOptions.push("Check modem hardware/firmware");
  if ((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) heuristicOptions.push("Check coverage or antenna");
  if (noService && cell.sim_inserted !== false) heuristicOptions.push("Run SIM Picker to check other carrier coverage");
  const otherOptions = Array.from(new Set([
    ...(cell.other_actions ?? []),
    ...heuristicOptions,
  ].filter((opt) => !!opt && opt !== primaryAction)));

  return [
    {
      title: "Details",
      rows: [
        { label: "Carrier", value: cellularCarrierLabel(cell) },
        { label: "Signal", value: cellularSignalDisplay(cell) },
        { label: "Connection", value: connected ? "Connected" : "Not connected" },
        { label: "Role", value: roleLabel(cell.role) || "Unknown" },
        { label: "SIM", value: cell.sim_inserted === false ? "Missing" : cell.sim_ready === true ? "Ready" : cell.imei ? "Detected" : "Unknown" },
        { label: "IMEI", value: cell.imei || "—" },
        { label: "Modem", value: cell.modem_not_present ? "Not detected" : cell.modem_unreachable ? "Detected — not responding" : cell.cellular_disabled && cell.imei ? "Powered off (detected)" : cell.cellular_disabled ? "Powered off" : cell.modem_present === true ? cell.modem_model ?? "Detected" : "Unknown" },
        { label: "Network", value: [cell.rat, cell.band].filter(Boolean).join(" / ") || "—" },
        { label: "APN", value: cleanCellIdentityValue(cell.at_apn) || cleanCellIdentityValue(cell.basic_apn) || "—" },
      ],
    },
    {
      title: "Details",
      rows: [
        { label: "Internet test", value: internetTest },
        { label: "Packet loss", value: `${cell.check_packet_loss_pct}%` },
        { label: "Latency", value: cell.check_avg_latency_ms !== null && cell.check_avg_latency_ms !== undefined ? `${cell.check_avg_latency_ms.toFixed(1)} ms` : "—" },
      ],
    },
    ...((primaryAction || otherOptions.length > 0) ? [{
      title: "Recommended Actions",
      rows: [
        ...(primaryAction ? [{ label: "Recommended action", value: primaryAction }] : []),
        ...(otherOptions.length > 0 ? [{ label: "Other options", value: otherOptions.join(" • ") }] : []),
      ],
    }] : []),
  ];
}

function buildSatelliteSections(sat?: SatelliteDiagnostic | null): DiagSection[] {
  if (!sat) return [{ title: "Details", rows: [{ label: "Details", value: "No diagnostics run" }, { label: "Last test", value: "—" }] }];

  const loopback =
    sat.satellite_state === "manager_unresponsive"
      ? "Unavailable"
      : sat.loopback_test_success === true
      ? "Passed"
      : sat.loopback_test_ran
        ? sat.loopback_test_success === false
          ? sat.loopback_test_blocked_in_use
            ? "Blocked"
            : "Failed"
          : "In progress"
        : "Not run";

  const defaultAction = !sat.loopback_test_ran && sat.modem_present === true
    ? sat.light_test_success === true ? "Run loopback for full verification" : "Run full satellite loopback test"
    : sat.loopback_test_blocked_in_use
      ? "Retry test when interface is idle"
      : sat.loopback_test_success === false
        ? "Check antenna placement and connection"
        : null;
  const primaryAction = sat.recommended_action || defaultAction;
  const otherActions = Array.from(new Set((sat.other_actions ?? []).filter((value) => !!value && value !== primaryAction)));
  const actions: DiagRow[] = [
    ...(primaryAction ? [{ label: "Recommended action", value: primaryAction }] : []),
    ...otherActions.map((value) => ({ label: "Additional action", value })),
  ];

  return [
    {
      title: "Details",
      rows: [
        { label: "Modem", value: sat.modem_present === true ? "Detected" : sat.modem_present === false ? "Not detected" : "Unknown" },
        { label: "IMEI", value: sat.sat_imei || "—" },
        { label: "Loopback", value: loopback },
        ...(sat.light_test_ran ? [{
          label: "Quick check",
          value: sat.light_test_success === true
            ? "Passed"
            : sat.light_test_blocked_in_use
              ? "Blocked"
              : "Failed",
        }] : []),
        { label: "Visibility", value: sat.satellites_seen !== null && sat.satellites_seen !== undefined ? `${sat.satellites_seen} satellites` : "Not available" },
        { label: "Packet loss", value: sat.loopback_packet_loss_pct !== null && sat.loopback_packet_loss_pct !== undefined ? `${sat.loopback_packet_loss_pct}%` : "—" },
        {
          label: "Loopback duration",
          value: sat.loopback_test_success === true
            ? formatLoopback(sat.loopback_duration_seconds ?? sat.total_time_seconds)
            : "—",
        },
      ],
    },
    ...(actions.length || sat.loopback_test_error || sat.light_test_error ? [{
      title: "Recommended Actions",
      rows: [
        ...actions,
        ...(sat.loopback_test_error ? [{ label: "Last error", value: sat.loopback_test_error }] : sat.light_test_error ? [{ label: "Last error", value: sat.light_test_error }] : []),
      ],
    }] : []),
  ];
}

function buildEthernetSections(ethernet?: EthernetDiagnostic | null): DiagSection[] {
  if (!ethernet) return [{ title: "Details", rows: [{ label: "Details", value: "No data yet" }, { label: "Last test", value: "—" }] }];

  const hasAuthoritativeCheck = ethernetHasAuthoritativeCheck(ethernet);
  const internetPassed = ethernetCheckPassed(ethernet);
  const disabled = ethernetCheckDisabled(ethernet);
  const disconnected = ethernetCheckDisconnected(ethernet);
  const connected = hasAuthoritativeCheck
    ? internetPassed
    : internetPassed || ethernet.link_detected === true;
  const connectionLabel = disabled
    ? "Disabled"
    : disconnected
      ? "No Ethernet link"
      : connected
        ? "Connected"
        : ethernet.link_detected === false
          ? "No Ethernet link"
          : "No data";
  const roleValue = disabled ? "Inactive" : connected ? "Connected path" : "Inactive";
  const internetTest = hasAuthoritativeCheck
    ? internetPassed
      ? "Passed"
      : disabled || disconnected
        ? "Not run"
        : "Failed"
    : connected
      ? "Retest"
      : "Not run";
  const actions: DiagRow[] = [];
  if (!internetPassed && ethernet.link_detected === false) actions.push({ label: "Recommended action", value: "⚠ If ethernet intended to be configured, check cable or switch" });
  else if (!hasAuthoritativeCheck && connected && !ethernet.ip_address) actions.push({ label: "Recommended action", value: "Check DHCP / static IP configuration" });
  else if (ethernet.flap_count > 0) actions.push({ label: "Recommended action", value: "Inspect link stability and port health" });
  if (hasAuthoritativeCheck && disconnected) {
    actions.length = 0;
    actions.push({ label: "Recommended action", value: "⚠ If ethernet intended to be configured, check cable or switch" });
  }

  return [
    {
      title: "Details",
      rows: [
        { label: "Connection", value: connectionLabel },
        { label: "Speed", value: speedLabel(ethernet.speed) + (ethernet.duplex ? ` (${ethernet.duplex})` : "") },
        { label: "Role", value: roleValue },
        { label: "Internet test", value: internetTest },
        { label: "Stability", value: ethernet.flap_count > 0 ? "Recent link flaps" : "Stable" },
      ],
    },
    ...(actions.length ? [{ title: "Recommended Actions", rows: actions }] : []),
  ];
}

function formatPsi(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)} PSI`;
}

const PRESSURE_NEAR_ZERO_DISPLAY_THRESHOLD = 0.5;

function formatPressureSummaryPsi(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (Math.abs(value) < PRESSURE_NEAR_ZERO_DISPLAY_THRESHOLD) return "~0.0 PSI";
  return `${value.toFixed(1)} PSI`;
}

function buildPressureSections(pressure?: PressureDiagnostic | null): DiagSection[] {
  if (!pressure) return [{ title: "Details", rows: [{ label: "Details", value: "No recent data" }] }];
  const source = pressure.sensors?.source;
  const distribution = pressure.sensors?.distribution;
  const supply = pressure.sensors?.supply;
  const readings: DiagRow[] = [];

  if (distribution) {
    const inactiveExpected = pressure.is_active === false && distribution.latest < 1.0;
    readings.push({
      label: "P2 Distribution Pressure",
      value: inactiveExpected
        ? `${formatPsi(distribution.latest)} (inactive — expected)`
        : `${formatPsi(distribution.latest)}${distribution.voltage !== null && distribution.voltage !== undefined ? ` · ${distribution.voltage.toFixed(2)}V` : ""}`,
    });
  }
  if (source) readings.push({ label: "P3 Source Pressure", value: `${formatPsi(source.latest)}${source.voltage !== null && source.voltage !== undefined ? ` · ${source.voltage.toFixed(2)}V` : ""}` });
  if (supply) readings.push({ label: "P1 Supply Pressure", value: `${formatPsi(supply.latest)}${supply.voltage !== null && supply.voltage !== undefined ? ` · ${supply.voltage.toFixed(2)}V` : ""}` });

  if (!supply) {
    const missingP1 = (pressure.sensor_errors ?? []).find((e) => e.sensor_index === 0 && e.errno === -2);
    if (missingP1 && /mp3|lv2|cds/i.test(pressure.system_type ?? "")) {
      readings.push({ label: "P1 Supply Pressure", value: "not installed (expected)" });
    }
  }
  for (const err of pressure.sensor_errors ?? []) {
    if (err.sensor_index === 0 && err.errno === -2 && /mp3|lv2|cds/i.test(pressure.system_type ?? "")) continue;
    const sensorLabel = (["P1 Supply", "P2 Distribution", "P3 Source"] as const)[err.sensor_index] ?? `Sensor ${err.sensor_index}`;
    readings.push({ label: `${sensorLabel} Pressure`, value: `missing — ${err.message}` });
  }

  const stats: DiagRow[] = [];
  for (const sensor of [source, distribution, supply].filter(Boolean) as PressureSensorReading[]) {
    if (sensor.count > 1) {
      stats.push({ label: sensor.name, value: `μ ${sensor.mean.toFixed(2)} · ${sensor.min.toFixed(2)}–${sensor.max.toFixed(2)} · σ ${sensor.stdev.toFixed(3)}` });
    }
  }

  const issues = (pressure.issues ?? []).map((issue) => ({
    label: issue.title,
    value: `${issue.description} · ${issue.action}`,
  }));

  return [
    { title: "Details", rows: readings.length ? readings : [{ label: "Readings", value: "No pressure readings captured" }] },
    ...(stats.length ? [{ title: "Live stats", rows: stats }] : []),
    ...(issues.length ? [{ title: "Recommended Actions", rows: issues }] : []),
  ];
}

function buildPressurePrimaryTags(pressure?: PressureDiagnostic | null): string[] {
  if (!pressure) return [];
  const source = pressure.sensors?.source?.latest;
  const hasSource = source !== null && source !== undefined && !Number.isNaN(source);
  if (hasSource) return ["P3 Source Pressure"];
  const via = (pressure.via_sensor ?? "").toLowerCase();
  if (via === "distribution") return ["P2 Distribution Pressure"];
  if (via === "source") return ["P3 Source Pressure"];
  if (via === "supply") return ["P1 Supply Pressure"];
  return [];
}

function buildPressureSecondaryTags(pressure?: PressureDiagnostic | null): string[] {
  if (!pressure) return [];
  const distribution = pressure.sensors?.distribution?.latest;
  const hasDistribution = distribution !== null && distribution !== undefined && !Number.isNaN(distribution);
  return hasDistribution ? ["P2 Distribution Pressure"] : [];
}

function pressureMetricTone(pressure: PressureDiagnostic | null | undefined, metric: "source" | "distribution"): HealthTone {
  if (!pressure) return "neutral";
  const tokens = metric === "source" ? ["p3", "source"] : ["p2", "distribution"];
  const matchingIssues = (pressure.issues ?? []).filter((issue) => {
    const haystack = `${issue.title} ${issue.description}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
  if (matchingIssues.some((issue) => issue.severity === "red")) return "error";
  if (matchingIssues.some((issue) => issue.severity === "orange")) return "warning";
  return pressure.status === "red" ? "error" : pressure.status === "orange" ? "warning" : "healthy";
}

function buildPressureMetricCards(pressure?: PressureDiagnostic | null): Array<{ label: string; value: string; tone: HealthTone }> {
  if (!pressure) return [];
  const source = pressure.sensors?.source?.latest;
  const distribution = pressure.sensors?.distribution?.latest;
  const hasSource = source !== null && source !== undefined && !Number.isNaN(source);
  const hasDistribution = distribution !== null && distribution !== undefined && !Number.isNaN(distribution);
  const cards: Array<{ label: string; value: string; tone: HealthTone }> = [];
  if (hasSource) {
    cards.push({
      label: "Source (P3)",
      value: formatPressureSummaryPsi(source),
      tone: pressureMetricTone(pressure, "source"),
    });
  }
  if (hasDistribution) {
    cards.push({
      label: "Distribution (P2)",
      value: formatPressureSummaryPsi(distribution),
      tone: pressureMetricTone(pressure, "distribution"),
    });
  }
  return cards;
  /*
  if (hasSource) {
    const sourceIssues = (pressure.issues ?? []).filter((i) => {
      const h = `${i.title} ${i.description}`.toLowerCase();
      return h.includes("p3") || h.includes("source");
    });
    const issueText = sourceIssues.length > 0 ? sourceIssues[0].title : "";
    cards.push({
      label: "Source (P3)",
      value: issueText
        ? `${formatPressureSummaryPsi(source)} · ${issueText}`
        : formatPressureSummaryPsi(source),
      tone: pressureMetricTone(pressure, "source"),
    });
  }
  if (hasDistribution) {
    const distIssues = (pressure.issues ?? []).filter((i) => {
      const h = `${i.title} ${i.description}`.toLowerCase();
      return h.includes("p2") || h.includes("distribution");
    });
    const issueText = distIssues.length > 0 ? distIssues[0].title : "";
    cards.push({
      label: "Distribution (P2)",
      value: issueText
        ? `${formatPressureSummaryPsi(distribution)} · ${issueText}`
        : formatPressureSummaryPsi(distribution),
      tone: pressureMetricTone(pressure, "distribution"),
    });
  }
  return cards;
  */
}

type CardSummary = {
  health: HealthTone;
  badgeLabel: string;
  primaryLine: string;
  secondaryLine?: string | null;
  signalLabel?: string | null;
  signalScore?: number | null;
};

function resolvePrimaryNetwork(diag: { wifi?: WifiDiagnostic | null; cellular?: CellularDiagnostic | null; satellite?: SatelliteDiagnostic | null; ethernet?: EthernetDiagnostic | null; system?: SystemDiagnostic | null }): "wifi" | "cellular" | "ethernet" | null {
  if (diag.satellite?.default_via_eth0 === true) return "ethernet";
  if (diag.satellite?.default_via_wlan0 === true || diag.wifi?.default_via_wlan0 === true) return "wifi";
  if (diag.satellite?.default_via_wwan0 === true) return "cellular";

  const active = (diag.wifi?.connman_active_service || diag.cellular?.connman_active_service || diag.satellite?.connman_active_service || "").toLowerCase();
  if (active.includes("eth")) return "ethernet";
  if (active.includes("wlan") || active.includes("wifi")) return "wifi";
  if (active.includes("wwan") || active.includes("cell")) return "cellular";

  if (diag.ethernet?.internet_reachable) return "ethernet";
  if (diag.wifi?.connected || diag.wifi?.connman_wifi_connected || diag.wifi?.internet_reachable) return "wifi";
  if (diag.cellular?.connman_cell_connected || diag.cellular?.internet_reachable) return "cellular";

  const preferred = (diag.system?.preferred_network || "").toLowerCase();
  if (preferred.includes("eth")) return "ethernet";
  if (preferred.includes("wifi") || preferred.includes("wlan")) return "wifi";
  if (preferred.includes("cell") || preferred.includes("wwan")) return "cellular";

  // Final deterministic fallback by station preference among connected paths.
  const ethConnected = diag.ethernet?.internet_reachable === true;
  const wifiConnected = diag.wifi?.connected === true
    || diag.wifi?.connman_wifi_connected === true
    || diag.wifi?.internet_reachable === true;
  const cellConnected = diag.cellular?.connman_cell_connected === true
    || diag.cellular?.internet_reachable === true;
  if (ethConnected) return "ethernet";
  if (wifiConnected) return "wifi";
  if (cellConnected) return "cellular";
  return null;
}

function resolveRole(network: "wifi" | "cellular" | "ethernet", primary: "wifi" | "cellular" | "ethernet" | null, connected: boolean): string | null {
  if (!connected) return "Inactive";
  return primary === network ? "Primary" : "Backup";
}

function summarizeWifi(wifi?: WifiDiagnostic | null): CardSummary {
  if (!wifi) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  const connected = wifiConnectedState(wifi);
  const ssid = wifi.access_point || wifi.ssid || "Wi-Fi";
  if (!connected) {
    const checkErrLower = (wifi.check_error || "").toLowerCase();
    const notEnabled = checkErrLower.includes("-65553")
      || checkErrLower.includes("not enabled")
      || wifi.connman_wifi_powered === false;
    if (notEnabled) {
      return { health: "warning", badgeLabel: "Inactive", primaryLine: "Not connected", secondaryLine: "Network technology is not enabled" };
    }
    return { health: "neutral", badgeLabel: "Inactive", primaryLine: "Not connected", secondaryLine: ssid };
  }
  const sig = wifiSignalLabel(wifi);
  const weakByController = (wifi.strength_label || "").toLowerCase() === "weak";
  if (weakByController) {
    return { health: "warning", badgeLabel: "Warning", primaryLine: ssid, secondaryLine: "Connected", signalLabel: sig, signalScore: wifi.strength_score };
  }
  if ((wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25) {
    return { health: "warning", badgeLabel: "Warning", primaryLine: ssid, secondaryLine: "Monitoring recommended", signalLabel: sig, signalScore: wifi.strength_score };
  }
  if (wifi.check_result === "Failure") {
    return { health: "warning", badgeLabel: "Warning", primaryLine: ssid, secondaryLine: "Connected · limited data", signalLabel: sig, signalScore: wifi.strength_score };
  }
  return { health: "healthy", badgeLabel: "Healthy", primaryLine: ssid, secondaryLine: "Connected", signalLabel: sig, signalScore: wifi.strength_score };
}

function summarizeCellular(cell?: CellularDiagnostic | null): CardSummary {
  if (!cell) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  if (cell.modem_unreachable) return { health: "error", badgeLabel: "Issue", primaryLine: "Cellular hardware not responding", secondaryLine: "Reboot controller" };
  if (cell.modem_present === false) return { health: "error", badgeLabel: "Issue", primaryLine: "No modem detected" };
  if (cell.sim_inserted === false) return { health: "error", badgeLabel: "Issue", primaryLine: "No SIM detected" };
  const connected = cellularConnectedState(cell);
  const carrier = cellularCarrierLabel(cell);
  const sig = cellularSignalLabel(cell);
  const noService = cellularExplicitNoService(cell);
  if (noService) return { health: "error", badgeLabel: "Issue", primaryLine: "No service", secondaryLine: carrier };
  if (!connected && cell.connman_cell_ready === true) {
    return { health: "warning", badgeLabel: "Warning", primaryLine: carrier, secondaryLine: "Registered · not connected", signalLabel: sig, signalScore: cell.strength_score };
  }
  if (!connected && cell.connman_cell_powered === false) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "Cellular disabled" };
  if (!connected) return { health: "warning", badgeLabel: "Warning", primaryLine: carrier, secondaryLine: "Searching for service", signalLabel: sig, signalScore: cell.strength_score };
  if ((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) {
    return { health: "warning", badgeLabel: "Warning", primaryLine: carrier, secondaryLine: "Weak signal", signalLabel: sig, signalScore: cell.strength_score };
  }
  return { health: "healthy", badgeLabel: "Healthy", primaryLine: carrier, secondaryLine: "Connected", signalLabel: sig, signalScore: cell.strength_score };
}

function summarizeEthernet(ethernet?: EthernetDiagnostic | null): CardSummary {
  if (!ethernet) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  if (ethernetCheckDisabled(ethernet)) {
    return { health: "neutral", badgeLabel: "Inactive", primaryLine: "Ethernet disabled" };
  }
  if (ethernetCheckDisconnected(ethernet)) {
    return { health: "neutral", badgeLabel: "Inactive", primaryLine: "No Ethernet link" };
  }
  const internetPassed = ethernetCheckPassed(ethernet);
  if (internetPassed) return { health: "healthy", badgeLabel: "Healthy", primaryLine: "Connected", secondaryLine: "Internet reachable" };
  if (ethernet.link_detected === false) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "No Ethernet link" };
  if (ethernet.flap_count > 0) return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Unstable link" };
  if (!ethernet.ip_address) return { health: "error", badgeLabel: "Issue", primaryLine: "Connected", secondaryLine: "No IP assigned" };
  return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Limited internet" };
}

function summarizePressure(pressure?: PressureDiagnostic | null): CardSummary {
  if (!pressure) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  const health = pressure.status === "red" ? "error" : pressure.status === "orange" ? "warning" : "healthy";
  const badgeLabel = pressure.status === "red" ? "Error" : pressure.status === "orange" ? "Warning" : "Healthy";
  const source = pressure.sensors?.source?.latest;
  const distribution = pressure.sensors?.distribution?.latest;
  const hasSource = source !== null && source !== undefined && !Number.isNaN(source);
  const hasDistribution = distribution !== null && distribution !== undefined && !Number.isNaN(distribution);
  return {
    health,
    badgeLabel,
    primaryLine: hasSource
      ? formatPressureSummaryPsi(source)
      : pressure.display_psi !== null && pressure.display_psi !== undefined
        ? `${pressure.display_psi.toFixed(1)} PSI`
        : "—",
    secondaryLine: hasDistribution ? formatPressureSummaryPsi(distribution) : null,
  };
}

function summarizeSatellite(sat?: SatelliteDiagnostic | null): CardSummary {
  if (!sat) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  if (sat.modem_present === false) return { health: "error", badgeLabel: "Issue", primaryLine: "No satellite modem detected" };
  if (sat.satellite_state === "manager_unresponsive") {
    return {
      health: "error",
      badgeLabel: "Issue",
      primaryLine: "Satellite test unavailable",
      secondaryLine: "Network Manager unresponsive",
    };
  }
  if (sat.loopback_test_success === true) return { health: "healthy", badgeLabel: "Verified", primaryLine: "Link verified" };
  if (sat.loopback_test_blocked_in_use) return { health: "warning", badgeLabel: "Warning", primaryLine: "Test blocked" };
  if (sat.loopback_test_ran && sat.loopback_test_success === false) return { health: "error", badgeLabel: "Issue", primaryLine: "Loopback failed" };
  if (sat.loopback_test_ran) return { health: "warning", badgeLabel: "Running", primaryLine: "Loopback in progress" };
  if (sat.light_test_success === true) return { health: "healthy", badgeLabel: "Healthy", primaryLine: "Satellite check passed" };
  if (sat.light_test_ran && sat.light_test_success === false) return { health: "error", badgeLabel: "Issue", primaryLine: "Quick check failed" };
  if (sat.satellites_seen === 0) return { health: "error", badgeLabel: "Issue", primaryLine: "No satellites visible" };
  return { health: "neutral", badgeLabel: "Not validated", primaryLine: "Modem present", secondaryLine: "Full test not run" };
}

function signalBars(score?: number | null): number {
  if (score === null || score === undefined || Number.isNaN(score)) return 0;
  if (score >= 75) return 4;
  if (score >= 50) return 3;
  if (score >= 25) return 2;
  if (score > 0) return 1;
  return 0;
}

function DiagCard({
  title,
  icon,
  health,
  statusLabel,
  primaryTags,
  primaryLine,
  secondaryLine,
  secondaryTags,
  role,
  signalLabel: cardSignalLabel,
  signalScore,
  sections,
  updatedAt,
  expanded,
  onToggle,
  onCopyCommand,
  copied,
  onSendCommand,
  sent,
  compact,
  emphasizeSecondaryLine = false,
  onClear,
  updating,
  onForceRelease,
  countdown,
  collapsedMetricCards,
  inlineControls,
}: DiagCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);
  const hasSignalInfo =
    (signalScore !== null && signalScore !== undefined) || !!cardSignalLabel;
  const collapsedRecommendations = !expanded
    ? sections
      .filter((section) => ["recommended actions", "diagnostics", "next action"].includes(section.title.toLowerCase()))
      .flatMap((section) => section.rows.map((row) => row.value))
      .concat(
        sections
          .flatMap((section) => section.rows)
          .filter((row) => row.label.toLowerCase().includes("recommended action"))
          .map((row) => row.value),
      )
      .filter((value, index, arr) => !!value && arr.indexOf(value) === index)
      .join(" • ")
    : [];
  const collapsedRecommendationCards = Array.isArray(collapsedRecommendations)
    ? collapsedRecommendations
    : collapsedRecommendations
      ? collapsedRecommendations.split(" â€¢ ").filter(Boolean)
      : [];
  const collapsedRecommendation = null;
  const collapsedRecommendationCardsNormalized = collapsedRecommendationCards
    .flatMap((recommendation) => recommendation.split(/\s+(?:•|â€¢|Ã¢â‚¬Â¢)\s+/).filter(Boolean))
    .map(stripLeadingWarningIcon)
    .filter((value, index, arr) => !!value && arr.indexOf(value) === index);

  return (
    <article className={`diag-card diag-card-${updating ? "neutral" : health} ${expanded ? "diag-card-open" : "diag-card-collapsed"} ${compact ? "diag-card-compact" : ""} ${emphasizeSecondaryLine ? "diag-card-equal-lines" : ""}`}>
      <div className="diag-card-head">
        <div className="diag-card-title-wrap">
          <span className="diag-card-icon" aria-hidden>{icon}</span>
          <span className="diag-card-title">
            {title}
          </span>
          {role ? <span className="diag-role-pill-inline">{role}</span> : null}
          {inlineControls}
        </div>
        <div className="diag-card-head-right">
          <span className="diag-status-label">
            <span className={`diag-status-dot diag-status-${updating ? "neutral" : health}`} />
            {updating && countdown
              ? <ProgressCountdown {...countdown} />
              : <span>{updating ? "Updating…" : statusLabel}</span>}
          </span>
          {onClear && (
            <div className="diag-card-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="diag-card-menu-btn"
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-label={`${title} actions`}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="diag-card-menu">
                  {(onCopyCommand || onSendCommand) && (
                    <>
                      <div className="diag-card-menu-inline">
                        <span className="diag-card-menu-inline-label">Diag commands</span>
                        <div className="diag-card-menu-inline-actions">
                          {onCopyCommand && (
                            <button
                              type="button"
                              className="diag-card-menu-chip"
                              onClick={() => {
                                onCopyCommand();
                                setMenuOpen(false);
                              }}
                            >
                              {copied ? "Copied" : "Copy"}
                            </button>
                          )}
                          {onSendCommand && (
                            <button
                              type="button"
                              className="diag-card-menu-chip"
                              onClick={() => {
                                onSendCommand();
                                setMenuOpen(false);
                              }}
                            >
                              {sent ? "Sent" : "Send"}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="diag-card-menu-divider" />
                    </>
                  )}
                  {onClear && (
                    <button
                      type="button"
                      className="diag-card-menu-item diag-card-menu-item-danger"
                      onClick={() => {
                        onClear();
                        setMenuOpen(false);
                      }}
                    >
                      Clear card
                    </button>
                  )}
                  {updating && onForceRelease && (
                    <button
                      type="button"
                      className="diag-card-menu-item"
                      onClick={() => {
                        onForceRelease();
                        setMenuOpen(false);
                      }}
                    >
                      Release update hold
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {collapsedMetricCards && collapsedMetricCards.length > 0 ? (
        <div className="diag-pressure-metric-grid">
          {collapsedMetricCards.map((metric) => (
            <div key={`${title}-${metric.label}`} className={`diag-pressure-metric-card diag-pressure-metric-card-${metric.tone}`}>
              <div className="diag-pressure-metric-label">{metric.label}</div>
              <div className="diag-pressure-metric-value">{metric.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="diag-card-status-row">
            <div className="diag-card-status-line">{primaryLine}</div>
            {primaryTags && primaryTags.length > 0 && (
              <div className="diag-card-primary-tags">
                {primaryTags.map((tag) => (
                  <span key={`${title}-${tag}`} className="diag-role-pill-inline">{tag}</span>
                ))}
              </div>
            )}
          </div>
          {(secondaryLine || (secondaryTags && secondaryTags.length > 0)) && (
            <div className="diag-card-secondary-row">
              {secondaryLine && <div className="diag-card-secondary-line">{secondaryLine}</div>}
              {secondaryTags && secondaryTags.length > 0 && (
                <div className="diag-card-secondary-tags">
                  {secondaryTags.map((tag) => (
                    <span key={`${title}-${tag}`} className="diag-role-pill-inline">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {hasSignalInfo && (
        <div className="diag-card-subline">
          {signalScore !== null && signalScore !== undefined && (
            <span className={`diag-signal-bars tone-${signalBars(signalScore) >= 3 ? "good" : signalBars(signalScore) >= 2 ? "warn" : "bad"}`} aria-hidden>
              <i className={signalBars(signalScore) >= 1 ? "on" : ""} />
              <i className={signalBars(signalScore) >= 2 ? "on" : ""} />
              <i className={signalBars(signalScore) >= 3 ? "on" : ""} />
              <i className={signalBars(signalScore) >= 4 ? "on" : ""} />
            </span>
          )}
          {cardSignalLabel && <span>{cardSignalLabel}</span>}
        </div>
      )}
      {collapsedRecommendation && <div className="diag-card-collapsed-reco">⚠️ {collapsedRecommendation}</div>}

      {collapsedRecommendationCardsNormalized.map((recommendation) => (
        <div key={`${title}-${recommendation}`} className="diag-card-collapsed-reco">⚠️ {recommendation}</div>
      ))}

      {expanded && (
        <div className="diag-details-wrap">
          {sections.map((section) => (
            <section key={`${title}-${section.title}`} className="diag-details-section">
              <h4>{section.title}</h4>
              <div>
                {section.rows.map((row) => (
                  <div key={`${title}-${section.title}-${row.label}`} className="diag-row">
                    <div className="diag-row-label">{row.label}</div>
                    <div className="diag-row-value">{row.value}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="diag-card-footer">
        <div className="diag-card-updated">{updatedAt ? `Updated ${updatedAt}` : "Updated —"}</div>
        <button type="button" className="diag-card-toggle" onClick={onToggle}>
          {expanded ? "Hide details ▴" : "Details ▾"}
        </button>
      </div>
    </article>
  );
}

// ─── Firmware helpers ────────────────────────────────────────────────────────

const DEFAULT_LATEST_FIRMWARE = "r3.3.1";

function parseFirmwareVersion(v: string): [number, number, number] | null {
  const m = /^r(\d+)\.(\d+)(?:\.(\d+))?/i.exec(v.trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? "0", 10)];
}

function compareFirmwareVersions(a: string, b: string): number {
  const pa = parseFirmwareVersion(a);
  const pb = parseFirmwareVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function buildFirmwareSummary(currentVersion: string | null | undefined, latestVersion: string) {
  if (!currentVersion) {
    return {
      health: "neutral" as HealthTone,
      statusLabel: "No data",
      primaryLine: "No data yet",
      secondaryLine: "Run diagnostics to populate",
      updateAvailable: null as boolean | null,
      notes: "—",
      recommendedAction: null as string | null,
    };
  }
  if (!parseFirmwareVersion(currentVersion)) {
    return {
      health: "error" as HealthTone,
      statusLabel: "Issue",
      primaryLine: "Firmware issue",
      secondaryLine: "Version unreadable",
      updateAvailable: null as boolean | null,
      notes: "Version string could not be parsed",
      recommendedAction: "Run version command again",
    };
  }
  if (compareFirmwareVersions(currentVersion, latestVersion) < 0) {
    return {
      health: "warning" as HealthTone,
      statusLabel: "Update available",
      primaryLine: "Update available",
      secondaryLine: currentVersion,
      updateAvailable: true,
      notes: "Recommended update",
      recommendedAction: "Update firmware",
    };
  }
  return {
    health: "healthy" as HealthTone,
    statusLabel: "Up to date",
    primaryLine: "Up to date",
    secondaryLine: currentVersion,
    updateAvailable: false,
    notes: "Current release",
    recommendedAction: null as string | null,
  };
}

function buildFirmwareSections(
  summary: ReturnType<typeof buildFirmwareSummary>,
  currentVersion: string | null | undefined,
  latestVersion: string,
): DiagSection[] {
  const details: DiagRow[] = [
    { label: "Version", value: currentVersion ?? "—" },
    { label: "Latest", value: latestVersion },
    {
      label: "Update available",
      value: summary.updateAvailable === true ? "Yes" : summary.updateAvailable === false ? "No" : "—",
    },
    { label: "Notes", value: summary.notes },
  ];
  const sections: DiagSection[] = [{ title: "Details", rows: details }];
  if (summary.recommendedAction) {
    sections.push({
      title: "Recommended Actions",
      rows: [{ label: "Recommended action", value: summary.recommendedAction }],
    });
  }
  return sections;
}

function FirmwareVersionEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const norm = draft.trim().toLowerCase();
    if (/^r\d+\.\d+(\.\d+)?$/.test(norm)) onChange(norm);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="firmware-version-input"
        value={draft}
        size={7}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        autoFocus
      />
    );
  }
  return (
    <button
      type="button"
      className="firmware-version-pill"
      onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}
    >
      latest: {value}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DiagnosticsTab() {
  const [rawDiag, setRawDiag] = useState<DiagnosticState | null>(null);
  const [displayDiag, setDisplayDiag] = useState<DiagnosticState | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    wifi: false,
    cellular: false,
    satellite: false,
    ethernet: false,
    pressure: false,
    sim_picker: false,
    firmware: false,
  });
  const [cardUpdatedAt, setCardUpdatedAt] = useState<Record<string, string | null>>({
    wifi: null,
    cellular: null,
    satellite: null,
    ethernet: null,
    pressure: null,
    sim_picker: null,
  });
  const [latestFirmwareVersion, setLatestFirmwareVersion] = useState<string>(() => {
    try { return localStorage.getItem("fwds-latest-firmware") ?? DEFAULT_LATEST_FIRMWARE; } catch { return DEFAULT_LATEST_FIRMWARE; }
  });
  const prevCardsRef = useRef<Record<string, string>>({
    wifi: "",
    cellular: "",
    satellite: "",
    ethernet: "",
    pressure: "",
  });
  const prevSystemRef = useRef<string>("");
  const postClearUntilRef = useRef<number>(0);
  const [systemUpdatedAt, setSystemUpdatedAt] = useState<string | null>(null);
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);
  const [sentCommandId, setSentCommandId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [globalDiagTier, setGlobalDiagTier] = useState<GlobalDiagTier>("quick");
  const [globalDiagTooltipTier, setGlobalDiagTooltipTier] = useState<GlobalDiagTier | null>(null);
  const [pressureHhc, setPressureHhc] = useState<"mp3" | "hp6">("mp3");
  const [cardHolds, setCardHolds] = useState<Partial<Record<InterfaceKey, HoldState>>>({});
  const cardHoldsRef = useRef<Partial<Record<InterfaceKey, HoldState>>>({});
  // Sequential expiry timestamps computed when a diagnostic block is sent.
  // Each interface gets the timestamp at which its own work is expected to finish,
  // accounting for all preceding interfaces in the same block.
  const interfaceExpirationsRef = useRef<Partial<Record<InterfaceKey, number>>>({});
  const commandSentAtRef = useRef<number>(0);

  useEffect(() => {
    cardHoldsRef.current = cardHolds;
  }, [cardHolds]);

  // 1-second tick to keep countdowns live while any hold is active.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Object.keys(cardHolds).length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [cardHolds]);

  useEffect(() => {
    const st = displayDiag?.system?.system_type;
    if (!st) return;
    setPressureHhc(st.toLowerCase() === "hp6" ? "hp6" : "mp3");
  }, [displayDiag?.system?.system_type]);

  useEffect(() => {
    try { localStorage.setItem("fwds-latest-firmware", latestFirmwareVersion); } catch {}
  }, [latestFirmwareVersion]);

  useEffect(() => {
    invoke("start_log_watcher").catch(() => {});

    const id = setInterval(async () => {
      if (Date.now() < postClearUntilRef.current) return; // post-clear cooldown
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        const nowMs = Date.now();
        const now = new Date().toLocaleTimeString();
        const nextCards: Record<string, string> = {
          wifi: JSON.stringify(state.wifi ?? null),
          cellular: JSON.stringify(state.cellular ?? null),
          satellite: JSON.stringify(state.satellite ?? null),
          ethernet: JSON.stringify(state.ethernet ?? null),
          pressure: JSON.stringify(state.pressure ?? null),
          sim_picker: JSON.stringify(state.sim_picker ?? null),
        };
        const nextSystem = JSON.stringify(state.system ?? null);

        setCardUpdatedAt((prev) => {
          const updated = { ...prev };
          (Object.keys(nextCards) as Array<keyof typeof nextCards>).forEach((k) => {
            if (nextCards[k] !== prevCardsRef.current[k]) {
              updated[k] = now;
            }
          });
          return updated;
        });
        if (nextSystem !== prevSystemRef.current) {
          setSystemUpdatedAt(now);
        }
        prevCardsRef.current = nextCards;
        prevSystemRef.current = nextSystem;
        setRawDiag(state);

        // Pre-compute which holds will be released this cycle so setDisplayDiag
        // can write fresh data atomically — preventing the "no data" flash that
        // occurs when the hold is still present in the ref when setDisplayDiag
        // runs but then deleted by setCardHolds in the same React batch.
        const willBeReleasedThisCycle = new Set<InterfaceKey>();
        (Object.keys(cardHoldsRef.current) as InterfaceKey[]).forEach((iface) => {
          const hold = cardHoldsRef.current[iface];
          if (!hold) return;
          // started_at >= hold.startedAt means a new run completed even if polling
          // missed the in_progress=true transition (fast commands).
          const runStartedAtMs = parseBackendTime(state.interface_runs?.[iface]?.started_at);
          const runIsNewer = runStartedAtMs !== null && runStartedAtMs >= hold.startedAt;
          // For pressure there is no interface_runs entry — auto-confirm after a
          // grace period. We still guard release against stale data via baseline counts.
          const pressureGracePassed = iface === "pressure" && (nowMs - hold.startedAt) > 4000;
          const effectiveConfirmed = hold.inProgressConfirmed ||
            state.interface_runs?.[iface]?.in_progress === true ||
            runIsNewer || pressureGracePassed;
          // Pressure: require NEW counts beyond the baseline snapshotted at hold creation.
          const complete = iface === "pressure"
            ? isPressureCompleteVsBaseline(state, hold.pressureBaselineCounts)
            : isInterfaceComplete(iface, state);
          const countdownExpiresAt = interfaceExpirationsRef.current[iface];
          const countdownExpired = countdownExpiresAt != null && countdownExpiresAt <= nowMs;
          // Satellite: release early when IMEI is newly populated (fast-complete path).
          const satelliteGotData = iface === "satellite" &&
            "satelliteBaselineImei" in hold &&
            !!state.satellite?.sat_imei &&
            state.satellite.sat_imei !== hold.satelliteBaselineImei;
          if (
            (effectiveConfirmed && complete) ||
            hold.expiresAt <= nowMs ||
            (countdownExpired && complete) ||
            satelliteGotData
          ) {
            willBeReleasedThisCycle.add(iface);
          }
        });

        setDisplayDiag((prevDisplay) => {
          const base = prevDisplay ?? state;
          const next = { ...base };
          (Object.keys(nextCards) as InterfaceKey[]).forEach((iface) => {
            const hold = cardHoldsRef.current[iface];
            // Skip update if hold is still active AND not being released this cycle.
            if (hold && hold.expiresAt > nowMs && !willBeReleasedThisCycle.has(iface)) return;
            // Only let in_progress block the display while the hold is still protecting the
            // card (i.e., we know a fresh run is in flight). Once the hold is expired or
            // released this cycle, show whatever data the backend has — otherwise a card
            // can count all the way down and still never populate.
            if (!willBeReleasedThisCycle.has(iface) && state.interface_runs?.[iface]?.in_progress === true) return;
            (next as any)[iface] = (state as any)?.[iface] ?? null;
          });
          next.interface_runs = state.interface_runs ?? {};
          next.system = state.system ?? null;
          next.last_updated = state.last_updated;
          next.session_has_data = state.session_has_data;
          return next;
        });
        setCardHolds((prev) => {
          let changed = false;
          const next = { ...prev };
          (Object.keys(prev) as InterfaceKey[]).forEach((iface) => {
            const hold = prev[iface];
            if (!hold) return;

            // Mark confirmed once the backend acknowledges the current run has started.
            // Without this, the first poll after Send may see in_progress=false from a
            // PREVIOUS run, and release would be triggered by stale completion data.
            if (!hold.inProgressConfirmed) {
              const runStartedAt = state.interface_runs?.[iface]?.started_at;
              const runIsNewer = runStartedAt != null &&
                new Date(runStartedAt).getTime() >= hold.startedAt;
              // Pressure has no interface_runs entry; auto-confirm after 4 s (2 polls).
              // Release is still guarded by the baseline count check, so stale data
              // from a prior session cannot trigger a premature release.
              const pressureGracePassed = iface === "pressure" && (nowMs - hold.startedAt) > 4000;
              if (
                state.interface_runs?.[iface]?.in_progress === true ||
                runIsNewer || pressureGracePassed
              ) {
                next[iface] = { ...hold, inProgressConfirmed: true };
                changed = true;
              }
            }

            const currentHold = next[iface] ?? hold;
            // Pressure: require NEW counts beyond the baseline snapshotted at hold creation.
            const complete = iface === "pressure"
              ? isPressureCompleteVsBaseline(state, currentHold.pressureBaselineCounts)
              : isInterfaceComplete(iface, state);
            const countdownExpiresAt = interfaceExpirationsRef.current[iface];
            const countdownExpired = countdownExpiresAt != null && countdownExpiresAt <= nowMs;
            // Satellite: release early when IMEI is newly populated (fast-complete path).
            const satelliteGotData = iface === "satellite" &&
              "satelliteBaselineImei" in (currentHold ?? {}) &&
              !!state.satellite?.sat_imei &&
              state.satellite.sat_imei !== currentHold.satelliteBaselineImei;
            // Release when: confirmed start + data complete, OR safety timeout,
            // OR countdown expired and data available, OR satellite IMEI just arrived.
            if (currentHold && (
              (currentHold.inProgressConfirmed && complete) ||
              currentHold.expiresAt <= nowMs ||
              (countdownExpired && complete) ||
              satelliteGotData
            )) {
              delete next[iface];
              changed = true;
            }
          });
          return changed ? next : prev;
        });
        setLastUpdated(state.last_updated ?? null);
      } catch {
        // best effort
      }
    }, 2000);

    const unlistenSid = listen("controller-sid-detected", async () => {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        setRawDiag(state);
        setDisplayDiag((prev) => {
          const next = { ...(prev ?? state) };
          next.system = state.system ?? null;
          next.interface_runs = state.interface_runs ?? {};
          next.session_has_data = state.session_has_data;
          return next;
        });
      } catch { /* best effort */ }
    });

    return () => {
      clearInterval(id);
      unlistenSid.then((fn) => fn());
    };
  }, []);

  const showNoSessionBanner = useMemo(() => !displayDiag?.session_has_data, [displayDiag]);

  const wifi = displayDiag?.wifi;
  const cellular = displayDiag?.cellular;
  const satellite = displayDiag?.satellite;
  const ethernet = displayDiag?.ethernet;
  const pressure = displayDiag?.pressure;
  const system = displayDiag?.system;
  const simPicker = displayDiag?.sim_picker;
  const wifiSummary = summarizeWifi(wifi);
  const cellularSummary = summarizeCellular(cellular);
  const satelliteSummary = summarizeSatellite(satellite);
  const ethernetSummary = summarizeEthernet(ethernet);
  const pressureSummary = summarizePressure(pressure);
  const currentFirmware = displayDiag?.system?.version ?? null;
  const firmwareSummary = buildFirmwareSummary(currentFirmware, latestFirmwareVersion);
  const primaryNetwork = resolvePrimaryNetwork({ wifi, cellular, satellite, ethernet, system });
  const wifiRole = resolveRole("wifi", primaryNetwork, wifiConnectedState(wifi));
  const cellularRole = resolveRole("cellular", primaryNetwork, cellularConnectedState(cellular));
  const ethernetRole = resolveRole("ethernet", primaryNetwork, !!(ethernet?.link_detected || ethernet?.internet_reachable));
  const isUpdating = (iface: InterfaceKey) => {
    // Pressure has no reliable backend in_progress tracking (no end marker in
    // most firmware versions), so only the frontend hold drives the updating state.
    if (iface === "pressure") return !!cardHolds[iface];
    return (displayDiag?.interface_runs?.[iface]?.in_progress === true) || !!cardHolds[iface];
  };

  async function clearCards() {
    await invoke("stop_log_watcher").catch(() => {});
    postClearUntilRef.current = Date.now() + 3000;
    const emptyState: DiagnosticState = {
      wifi: null,
      cellular: null,
      satellite: null,
      ethernet: null,
      pressure: null,
      system: null,
      sim_picker: null,
      interface_runs: {},
      last_updated: null,
      session_has_data: false,
    };
    setRawDiag(emptyState);
    setDisplayDiag(emptyState);
    setLastUpdated(null);
    setSystemUpdatedAt(null);
    setCardUpdatedAt({ wifi: null, cellular: null, satellite: null, ethernet: null, pressure: null, sim_picker: null });
    prevCardsRef.current = { wifi: "", cellular: "", satellite: "", ethernet: "", pressure: "", sim_picker: "" };
    prevSystemRef.current = "";
    setCopiedCommandId(null);
    setSentCommandId(null);
    setCardHolds({});
  }

  async function copyDiagnosticBlock(blockId: string) {
    const block = DIAGNOSTIC_BLOCKS.find((item) => item.id === blockId);
    if (!block) return;
    const script = resolveBlockScript(block, "heavy");
    if (!script) return;
    await navigator.clipboard.writeText(script).catch(() => {});
    setCopiedCommandId(blockId);
    setTimeout(() => setCopiedCommandId((prev) => (prev === blockId ? null : prev)), 1400);
  }

  async function sendDiagnosticBlock(blockId: string) {
    const block = DIAGNOSTIC_BLOCKS.find((item) => item.id === blockId);
    if (!block) return;
    const script = resolveBlockScript(block, "heavy");
    if (!script) return;
    const rawDiagSnapshot = rawDiag;
    const displayDiagSnapshot = displayDiag;
    const cardUpdatedAtSnapshot = cardUpdatedAt;
    try {
      const now = Date.now();
      const touchedInterfaces = interfacesForBlock(block, script);
      // Compute per-interface sequential expiry FIRST so hold.expiresAt and the
      // countdown ring both expire at the same moment (no "Done" ring while hold
      // is still blocking the card update).
      commandSentAtRef.current = now;
      const expirations: Partial<Record<InterfaceKey, number>> = {};
      let cursor = now;
      for (const iface of touchedInterfaces) {
        cursor += ifaceDurationMs(iface, script);
        expirations[iface] = cursor;
      }
      interfaceExpirationsRef.current = expirations;
      // Snapshot baselines before the hold is created so release logic can
      // distinguish genuinely new data from pre-existing (stale) readings.
      const pressureSnap = rawDiag?.pressure;
      const pressureBaseline = {
        source:       pressureSnap?.sensors?.source?.count       ?? 0,
        distribution: pressureSnap?.sensors?.distribution?.count ?? 0,
        supply:       pressureSnap?.sensors?.supply?.count       ?? 0,
      };
      const satelliteBaselineImei = rawDiag?.satellite?.sat_imei ?? null;

      await Promise.all(
        touchedInterfaces.map((iface) =>
          invoke("clear_diagnostic_interface", { interface: iface }).catch(() => {}),
        ),
      );

      setRawDiag((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        touchedInterfaces.forEach((iface) => {
          (next as any)[iface] = null;
        });
        return next;
      });
      setDisplayDiag((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        touchedInterfaces.forEach((iface) => {
          (next as any)[iface] = null;
        });
        return next;
      });
      setCardUpdatedAt((prev) => {
        const next = { ...prev };
        touchedInterfaces.forEach((iface) => {
          next[iface] = null;
        });
        return next;
      });

      setCardHolds((prev) => {
        const next = { ...prev };
        touchedInterfaces.forEach((iface) => {
          next[iface] = {
            startedAt: now,
            // Align hold timeout with the sequential countdown expiry, floored at
            // the interface's individual safety minimum (e.g. 60 s for most, 15 min
            // for satellite loopback) so short-sequential entries still get coverage.
            expiresAt: Math.max(
              now + holdTimeoutMsForInterface(iface, script),
              expirations[iface] ?? now + holdTimeoutMsForInterface(iface, script),
            ),
            reason: iface === "satellite" && script.toLowerCase().includes("satellite-check -t")
              ? "Satellite loopback in progress"
              : "Diagnostics command in progress",
            ...(iface === "pressure" ? { pressureBaselineCounts: pressureBaseline } : {}),
            ...(iface === "satellite" ? { satelliteBaselineImei } : {}),
          };
        });
        return next;
      });
      await sendCommandText(script);
      setSentCommandId(blockId);
      setTimeout(() => setSentCommandId((prev) => (prev === blockId ? null : prev)), 1400);
      setSendError(null);
    } catch (e) {
      setRawDiag(rawDiagSnapshot);
      setDisplayDiag(displayDiagSnapshot);
      setCardUpdatedAt(cardUpdatedAtSnapshot);
      setSendError(String(e) || "Open session first");
    }
  }

  function getCountdownProps(iface: InterfaceKey): CountdownProps | undefined {
    const hold = cardHolds[iface];
    if (!hold) return undefined;
    const expiresAt = interfaceExpirationsRef.current[iface] ?? hold.expiresAt;
    const sentAt    = commandSentAtRef.current || hold.startedAt;
    const totalMs   = Math.max(1, expiresAt - sentAt);
    const elapsedMs = Date.now() - sentAt;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    const progressFraction = Math.min(1, elapsedMs / totalMs);
    const isElapsedMode = hold.reason === "Satellite loopback in progress";
    return { progressFraction, remainingMs, elapsedMs, isElapsedMode };
  }

  const safeSid = system?.sid && /^\d{8}$/.test(system.sid) ? system.sid : null;
  const safeVersion = system?.version && /^r\d+\.\d+/.test(system.version) ? system.version : null;
  const systemIdentity = [
    safeSid ? `SID ${safeSid}` : null,
    safeVersion ? `v${safeVersion}` : null,
    system?.controller_date || system?.release_date || null,
    system?.system_type ? system.system_type : null,
  ].filter(Boolean).join(" · ");
  const pressureDiagBlockId = pressureHhc === "hp6" ? "pressure-hp6" : "pressure-mp3";
  const globalDiagBlockId = GLOBAL_DIAG_MODES[globalDiagTier].blockId;
  const globalDiagModes = Object.entries(GLOBAL_DIAG_MODES) as [GlobalDiagTier, (typeof GLOBAL_DIAG_MODES)[GlobalDiagTier]][];

  function releaseCardHold(iface: InterfaceKey) {
    setCardHolds((prev) => {
      if (!prev[iface]) return prev;
      const next = { ...prev };
      delete next[iface];
      return next;
    });
    setDisplayDiag((prev) => {
      if (!prev || !rawDiag) return prev;
      const next = { ...prev, [iface]: (rawDiag as any)?.[iface] ?? null };
      // Force in_progress=false so the static "Updating…" label clears immediately
      // even when the backend still reports in_progress=true for this interface.
      if (next.interface_runs?.[iface]) {
        next.interface_runs = {
          ...next.interface_runs,
          [iface]: { ...next.interface_runs[iface], in_progress: false },
        };
      }
      return next;
    });
    setCardUpdatedAt((prev) => ({ ...prev, [iface]: new Date().toLocaleTimeString() }));
  }

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div className="diag-header-left">
          <h2>System Diagnostics</h2>
          {systemIdentity && <div className="diag-system-line">{systemIdentity}</div>}
          {systemUpdatedAt && <div className="diag-system-line">System updated {systemUpdatedAt}</div>}
          <div className="diag-header-toolbar">
            <div className="diag-toolbar-section diag-toolbar-section-mode">
              <span className="diag-toolbar-label">Mode</span>
              <div className="btn-group" role="group" aria-label="Diagnostics mode">
                {globalDiagModes.map(([tier, mode], index) => {
                  const tooltipText = `${mode.label} (${mode.eta})`;
                  const tooltipId = `diag-mode-tooltip-${tier}`;
                  const tooltipAlignClass = index === 0
                    ? "diag-mode-tooltip-align-left"
                    : index === globalDiagModes.length - 1
                      ? "diag-mode-tooltip-align-right"
                      : "";
                  return (
                    <div
                      key={tier}
                      className="diag-mode-btn-wrap"
                      onMouseEnter={() => setGlobalDiagTooltipTier(tier)}
                      onMouseLeave={() => setGlobalDiagTooltipTier((current) => (current === tier ? null : current))}
                    >
                      <button
                        type="button"
                        className={`btn ${globalDiagTier === tier ? "btn-primary" : "btn-secondary"} diag-mode-btn`}
                        onClick={() => setGlobalDiagTier(tier)}
                        onFocus={() => setGlobalDiagTooltipTier(tier)}
                        onBlur={() => setGlobalDiagTooltipTier((current) => (current === tier ? null : current))}
                        aria-pressed={globalDiagTier === tier}
                        aria-describedby={tooltipId}
                      >
                        {mode.label}
                      </button>
                      <div
                        id={tooltipId}
                        role="tooltip"
                        className={`diag-mode-tooltip ${tooltipAlignClass} ${globalDiagTooltipTier === tier ? "diag-mode-tooltip-visible" : ""}`}
                      >
                        <strong>{tooltipText}</strong>
                        <span>{mode.summary}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="diag-toolbar-section">
              <span className="diag-toolbar-label">Request</span>
              <div className="btn-group">
                <button className="btn btn-secondary" onClick={clearCards}>Clear</button>
                <button className="btn btn-secondary" onClick={() => copyDiagnosticBlock(globalDiagBlockId)}>
                  {copiedCommandId === globalDiagBlockId ? "Copied" : "Copy"}
                </button>
                <button className="btn btn-secondary" onClick={() => sendDiagnosticBlock(globalDiagBlockId)}>
                  {sentCommandId === globalDiagBlockId ? "Sent" : "Send"}
                </button>
              </div>
            </div>
            {sendError && <div className="warning-item">⚠ {sendError}</div>}
          </div>
        </div>

        <div className="diag-header-right">
          <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
        </div>
      </div>
      {showNoSessionBanner && <div className="diag-empty-sub">Run diagnostics from terminal to populate live cards.</div>}

      <div className="diag-grid">
        <DiagCard
          title="Wi-Fi"
          icon="🛜"
          health={wifiSummary.health || toneFromStatus(wifi?.status)}
          statusLabel={wifiSummary.badgeLabel}
          primaryLine={wifiSummary.primaryLine}
          secondaryLine={wifiSummary.secondaryLine}
          role={wifiRole}
          signalLabel={wifiSummary.signalLabel}
          signalScore={wifiSummary.signalScore}
          sections={buildWifiSections(wifi)}
          expanded={expanded.wifi}
          onToggle={() => setExpanded((p) => ({ ...p, wifi: !p.wifi }))}
          updatedAt={cardUpdatedAt.wifi}
          onCopyCommand={() => copyDiagnosticBlock("wifi")}
          copied={copiedCommandId === "wifi"}
          onSendCommand={() => sendDiagnosticBlock("wifi")}
          sent={sentCommandId === "wifi"}
          compact={wifiSummary.health === "neutral"}
          updating={isUpdating("wifi")}
          onForceRelease={() => releaseCardHold("wifi")}
          countdown={getCountdownProps("wifi")}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "wifi" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, wifi: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, wifi: null }));
          }}
        />

        <DiagCard
          title="Cellular"
          icon="📶"
          health={cellularSummary.health || toneFromStatus(cellular?.status)}
          statusLabel={cellularSummary.badgeLabel}
          primaryLine={cellularSummary.primaryLine}
          secondaryLine={cellularSummary.secondaryLine}
          role={cellularRole}
          signalLabel={cellularSummary.signalLabel}
          signalScore={cellularSummary.signalScore}
          sections={buildCellularSections(cellular)}
          expanded={expanded.cellular}
          onToggle={() => setExpanded((p) => ({ ...p, cellular: !p.cellular }))}
          updatedAt={cardUpdatedAt.cellular}
          onCopyCommand={() => copyDiagnosticBlock("cellular")}
          copied={copiedCommandId === "cellular"}
          onSendCommand={() => sendDiagnosticBlock("cellular")}
          sent={sentCommandId === "cellular"}
          compact={cellularSummary.health === "neutral"}
          updating={isUpdating("cellular")}
          onForceRelease={() => releaseCardHold("cellular")}
          countdown={getCountdownProps("cellular")}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "cellular" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, cellular: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, cellular: null }));
          }}
        />

        <DiagCard
          title="Satellite"
          icon="🛰️"
          health={satelliteSummary.health || toneFromStatus(satellite?.status)}
          statusLabel={satelliteSummary.badgeLabel}
          primaryLine={satelliteSummary.primaryLine}
          secondaryLine={satelliteSummary.secondaryLine}
          role={satelliteSummary.health === "healthy" ? "Backup" : undefined}
          signalLabel={satelliteSummary.signalLabel}
          signalScore={satelliteSummary.signalScore}
          sections={buildSatelliteSections(satellite)}
          expanded={expanded.satellite}
          onToggle={() => setExpanded((p) => ({ ...p, satellite: !p.satellite }))}
          updatedAt={cardUpdatedAt.satellite}
          onCopyCommand={() => copyDiagnosticBlock("satellite")}
          copied={copiedCommandId === "satellite"}
          onSendCommand={() => sendDiagnosticBlock("satellite")}
          sent={sentCommandId === "satellite"}
          compact={satelliteSummary.health === "neutral"}
          updating={isUpdating("satellite")}
          onForceRelease={() => releaseCardHold("satellite")}
          countdown={getCountdownProps("satellite")}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "satellite" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, satellite: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, satellite: null }));
          }}
        />

        <DiagCard
          title="Ethernet"
          icon="🌐"
          health={ethernetSummary.health || toneFromStatus(ethernet?.status)}
          statusLabel={ethernetSummary.badgeLabel}
          primaryLine={ethernetSummary.primaryLine}
          secondaryLine={ethernetSummary.secondaryLine}
          role={ethernetRole}
          signalLabel={ethernetSummary.signalLabel}
          signalScore={ethernetSummary.signalScore}
          sections={buildEthernetSections(ethernet)}
          expanded={expanded.ethernet}
          onToggle={() => setExpanded((p) => ({ ...p, ethernet: !p.ethernet }))}
          updatedAt={cardUpdatedAt.ethernet}
          onCopyCommand={() => copyDiagnosticBlock("ethernet")}
          copied={copiedCommandId === "ethernet"}
          onSendCommand={() => sendDiagnosticBlock("ethernet")}
          sent={sentCommandId === "ethernet"}
          compact={ethernetSummary.health === "neutral"}
          updating={isUpdating("ethernet")}
          onForceRelease={() => releaseCardHold("ethernet")}
          countdown={getCountdownProps("ethernet")}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "ethernet" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, ethernet: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, ethernet: null }));
          }}
        />

        <DiagCard
          title="System Pressure"
          icon="💧"
          health={pressureSummary.health || toneFromStatus(pressure?.status)}
          statusLabel={pressureSummary.badgeLabel}
          primaryTags={buildPressurePrimaryTags(pressure)}
          secondaryTags={buildPressureSecondaryTags(pressure)}
          collapsedMetricCards={buildPressureMetricCards(pressure)}
          primaryLine={pressureSummary.primaryLine}
          secondaryLine={pressureSummary.secondaryLine}
          sections={buildPressureSections(pressure)}
          expanded={expanded.pressure}
          onToggle={() => setExpanded((p) => ({ ...p, pressure: !p.pressure }))}
          updatedAt={cardUpdatedAt.pressure}
          onCopyCommand={() => copyDiagnosticBlock(pressureDiagBlockId)}
          copied={copiedCommandId === pressureDiagBlockId}
          onSendCommand={() => sendDiagnosticBlock(pressureDiagBlockId)}
          sent={sentCommandId === pressureDiagBlockId}
          compact={pressureSummary.health === "neutral"}
          updating={isUpdating("pressure")}
          onForceRelease={() => releaseCardHold("pressure")}
          countdown={getCountdownProps("pressure")}
          inlineControls={
            <div className="pressure-hhc-pills" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`pressure-hhc-pill${pressureHhc === "mp3" ? " pressure-hhc-pill-active" : ""}`}
                onClick={() => setPressureHhc("mp3")}
              >MP3</button>
              <button
                type="button"
                className={`pressure-hhc-pill${pressureHhc === "hp6" ? " pressure-hhc-pill-active" : ""}`}
                onClick={() => setPressureHhc("hp6")}
              >HP6</button>
            </div>
          }
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "pressure" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, pressure: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, pressure: null }));
          }}
        />

        <DiagCard
          title="Firmware"
          icon="💾"
          health={firmwareSummary.health}
          statusLabel={firmwareSummary.statusLabel}
          primaryLine={firmwareSummary.primaryLine}
          secondaryLine={firmwareSummary.secondaryLine}
          sections={buildFirmwareSections(firmwareSummary, currentFirmware, latestFirmwareVersion)}
          expanded={expanded.firmware}
          onToggle={() => setExpanded((p) => ({ ...p, firmware: !p.firmware }))}
          updatedAt={systemUpdatedAt}
          onCopyCommand={() => copyDiagnosticBlock("firmware")}
          copied={copiedCommandId === "firmware"}
          onSendCommand={() => sendDiagnosticBlock("firmware")}
          sent={sentCommandId === "firmware"}
          compact={firmwareSummary.health === "neutral"}
          updating={Object.values(displayDiag?.interface_runs || {}).some(r => r.in_progress) && !currentFirmware}
          inlineControls={
            <FirmwareVersionEditor
              value={latestFirmwareVersion}
              onChange={setLatestFirmwareVersion}
            />
          }
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "system" }).catch(() => {});
            setDisplayDiag(prev =>
              prev ? { ...prev, system: prev.system ? { ...prev.system, version: null, release_date: null } : null } : prev
            );
          }}
        />
      </div>

      <div className="diag-sim-picker-section">
        <div className="diag-section-divider">
          <span className="diag-section-divider-label">SIM Picker</span>
        </div>
        <DiagCard
          title="SIM Picker"
          icon="📶"
          health={simPickerHealth(simPicker)}
          statusLabel={simPickerBadge(simPicker)}
          primaryLine={simPickerPrimary(simPicker)}
          secondaryLine={simPickerSecondary(simPicker)}
          sections={buildSimPickerSections(simPicker)}
          expanded={expanded.sim_picker}
          onToggle={() => setExpanded((p) => ({ ...p, sim_picker: !p.sim_picker }))}
          updatedAt={cardUpdatedAt.sim_picker}
          onCopyCommand={() => copyDiagnosticBlock("sim-picker")}
          copied={copiedCommandId === "sim-picker"}
          onSendCommand={() => sendDiagnosticBlock("sim-picker")}
          sent={sentCommandId === "sim-picker"}
          compact={!simPicker?.scan_attempted}
          updating={isUpdating("sim_picker")}
          onForceRelease={() => releaseCardHold("sim_picker")}
          countdown={getCountdownProps("sim_picker")}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "sim_picker" }).catch(() => {});
            setDisplayDiag(prev => prev ? { ...prev, sim_picker: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, sim_picker: null }));
          }}
        />
      </div>
    </section>
  );
}
