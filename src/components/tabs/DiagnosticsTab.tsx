import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DIAGNOSTIC_BLOCKS, DiagnosticBlock } from "../../types/commands";

type DiagStatus = "grey" | "green" | "orange" | "red" | "unknown";
type HealthTone = "healthy" | "warning" | "error" | "neutral";

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
  rat?: string | null;
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
  release_date?: string | null;
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
  last_updated?: string | null;
  session_has_data?: boolean;
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
}

function resolveBlockScript(block: DiagnosticBlock, tier: "light" | "heavy"): string {
  const custom = tier === "light" ? block.light_script : block.heavy_script;
  if (custom && custom.trim().length > 0) return custom;
  const ids = tier === "light" ? block.light_command_ids : block.heavy_command_ids;
  return ids.join("\n");
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

function wifiSignalLabel(wifi?: WifiDiagnostic | null): string {
  if (!wifi) return "No service";
  if (wifi.strength_label && wifi.strength_label.trim()) {
    return wifi.strength_label[0].toUpperCase() + wifi.strength_label.slice(1).toLowerCase();
  }
  return signalLabelFromDbm(wifi.signal_dbm) ?? signalLabel(wifi.strength_score);
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
  const wifiSig = wifiSignalLabel(wifi);
  const weakByController = (wifi.strength_label || "").toLowerCase() === "weak";
  const internetTest = wifi.check_result === "Success"
    ? "Passed"
    : wifi.check_result === "Failure"
      ? "Failed"
      : "Not run";

  const network: DiagRow[] = [
    { label: "Network", value: (wifi.ssid && !wifi.ssid.startsWith('=') ? wifi.ssid : null) || wifi.access_point || "Unknown" },
    { label: "Connection", value: wifi.connected === true ? "Connected" : "Not connected" },
    { label: "Signal", value: `${wifiSig}${wifi.signal_dbm !== null && wifi.signal_dbm !== undefined ? ` (${wifi.signal_dbm} dBm)` : ""}` },
    { label: "Role", value: wifi.default_via_wlan0 === true ? "Active" : wifi.connected === true ? "Backup" : "Inactive" },
    { label: "Speed", value: speedMbps !== null && speedMbps !== undefined ? `${speedMbps.toFixed(1)} Mbps` : "—" },
    { label: "Internet test", value: internetTest },
  ];

  const action: DiagRow[] = [];
  if (wifi.check_error) action.push({ label: "Recommended action", value: "Check passphrase or AP selection" });
  else if (weakByController || ((wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25)) {
    action.push({ label: "Recommended action", value: "Improve Wi-Fi coverage (move AP closer or add a repeater)" });
  }

  return [
    { title: "Details", rows: network },
    ...(action.length ? [{ title: "Recommended Actions", rows: action }] : []),
  ];
}

function buildCellularSections(cell?: CellularDiagnostic | null): DiagSection[] {
  if (!cell) return [{ title: "Details", rows: [{ label: "Details", value: "No recent data" }] }];

  const primaryAction = cell.recommended_action
    || (cell.sim_inserted === false ? "Insert SIM card" : null)
    || (cell.modem_present === false ? "Check modem hardware/firmware" : null)
    || (((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) ? "Check coverage or antenna" : null);

  const heuristicOptions: string[] = [];
  if (cell.sim_inserted === false) heuristicOptions.push("Insert SIM card");
  if (cell.modem_present === false) heuristicOptions.push("Check modem hardware/firmware");
  if ((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) heuristicOptions.push("Check coverage or antenna");
  const otherOptions = Array.from(new Set([
    ...(cell.other_actions ?? []),
    ...heuristicOptions,
  ].filter((opt) => !!opt && opt !== primaryAction)));

  return [
    {
      title: "Details",
      rows: [
        { label: "Carrier", value: cleanCellValue(cell.operator_name) || resolveCarrierCode(cell.provider_code) || resolveCarrierCode(cell.basic_provider) || "—" },
        { label: "Signal", value: signalLabel(cell.strength_score) + (cell.strength_score !== null && cell.strength_score !== undefined ? ` (${cell.strength_score}/100)` : "") },
        { label: "Connection", value: (cell.connman_cell_connected === true || cell.internet_reachable === true) ? "Connected" : "Not connected" },
        { label: "Role", value: roleLabel(cell.role) || "Inactive" },
        { label: "SIM", value: cell.sim_inserted === false ? "Missing" : cell.sim_ready === true ? "Ready" : "Unknown" },
        { label: "Modem", value: cell.modem_not_present ? "Not detected" : cell.modem_unreachable ? "Detected — not responding" : cell.cellular_disabled && cell.imei ? "Powered off (detected)" : cell.cellular_disabled ? "Powered off" : cell.modem_present === true ? cell.modem_model ?? "Detected" : "Unknown" },
        { label: "Network", value: [cell.rat, cell.band].filter(Boolean).join(" / ") || "—" },
        { label: "APN", value: cleanCellValue(cell.at_apn) || cleanCellValue(cell.basic_apn) || "—" },
      ],
    },
    {
      title: "Details",
      rows: [
        { label: "Internet test", value: cell.internet_reachable ? "Passed" : "Failed" },
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
    sat.loopback_test_success === true
      ? "Passed"
      : sat.loopback_test_ran
        ? sat.loopback_test_success === false
          ? sat.loopback_test_blocked_in_use
            ? "Blocked"
            : "Failed"
          : "In progress"
        : "Not run";

  const actions: DiagRow[] = [];
  if (!sat.loopback_test_ran && sat.modem_present === true) {
    actions.push({
      label: "Recommended action",
      value: sat.light_test_success === true ? "Run loopback for full verification" : "Run full satellite loopback test",
    });
  }
  else if (sat.loopback_test_blocked_in_use) actions.push({ label: "Recommended action", value: "Retry test when interface is idle" });
  else if (sat.loopback_test_success === false) actions.push({ label: "Recommended action", value: "Check antenna placement and connection" });
  else if (sat.recommended_action) actions.push({ label: "Recommended action", value: sat.recommended_action });

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

  const internetPassed = ethernet.check_result === "Success" && ethernet.internet_reachable === true;
  const connected = internetPassed || ethernet.link_detected === true;
  const actions: DiagRow[] = [];
  if (!internetPassed && ethernet.link_detected === false) actions.push({ label: "Recommended action", value: "Check cable or switch" });
  else if (!ethernet.ip_address) actions.push({ label: "Recommended action", value: "Check DHCP / static IP configuration" });
  else if (ethernet.flap_count > 0) actions.push({ label: "Recommended action", value: "Inspect link stability and port health" });

  return [
    {
      title: "Details",
      rows: [
        { label: "Connection", value: connected ? "Connected" : "No link" },
        { label: "Speed", value: speedLabel(ethernet.speed) + (ethernet.duplex ? ` (${ethernet.duplex})` : "") },
        { label: "Role", value: connected ? "Connected path" : "Inactive" },
        { label: "Internet test", value: internetPassed ? "Passed" : "Failed" },
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

function buildPressureSections(pressure?: PressureDiagnostic | null): DiagSection[] {
  if (!pressure) return [{ title: "Details", rows: [{ label: "Details", value: "No recent data" }] }];
  const source = pressure.sensors?.source;
  const distribution = pressure.sensors?.distribution;
  const supply = pressure.sensors?.supply;
  const readings: DiagRow[] = [];

  if (distribution) {
    const inactiveExpected = pressure.is_active === false && distribution.latest < 1.0;
    readings.push({
      label: "Distribution (P2)",
      value: inactiveExpected
        ? `${formatPsi(distribution.latest)} (inactive — expected)`
        : `${formatPsi(distribution.latest)}${distribution.voltage !== null && distribution.voltage !== undefined ? ` · ${distribution.voltage.toFixed(2)}V` : ""}`,
    });
  }
  if (source) readings.push({ label: "Source (P3)", value: `${formatPsi(source.latest)}${source.voltage !== null && source.voltage !== undefined ? ` · ${source.voltage.toFixed(2)}V` : ""}` });
  if (supply) readings.push({ label: "Supply (P1)", value: `${formatPsi(supply.latest)}${supply.voltage !== null && supply.voltage !== undefined ? ` · ${supply.voltage.toFixed(2)}V` : ""}` });

  if (!supply) {
    const missingP1 = (pressure.sensor_errors ?? []).find((e) => e.sensor_index === 0 && e.errno === -2);
    if (missingP1 && /mp3|lv2|cds/i.test(pressure.system_type ?? "")) {
      readings.push({ label: "Supply (P1)", value: "not installed (expected)" });
    }
  }
  for (const err of pressure.sensor_errors ?? []) {
    if (err.sensor_index === 0 && err.errno === -2 && /mp3|lv2|cds/i.test(pressure.system_type ?? "")) continue;
    readings.push({ label: `Sensor ${err.sensor_index}`, value: `missing — ${err.message}` });
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
  if (issues.length === 0) issues.push({ label: "✓ Healthy", value: "All sensors healthy — no anomalies detected" });

  return [
    { title: "Details", rows: readings.length ? readings : [{ label: "Readings", value: "No pressure readings captured" }] },
    ...(stats.length ? [{ title: "Live stats", rows: stats }] : []),
    { title: "Recommended Actions", rows: issues },
  ];
}

function buildPressurePrimaryTags(pressure?: PressureDiagnostic | null): string[] {
  if (!pressure) return [];
  const via = (pressure.via_sensor ?? "").toLowerCase();
  if (via === "distribution") return ["Distribution (P2)"];
  if (via === "source") return ["Source (P3)"];
  if (via === "supply") return ["Supply (P1)"];
  return [];
}

function buildPressureSecondaryTags(pressure?: PressureDiagnostic | null): string[] {
  if (!pressure) return [];
  const source = pressure.sensors?.source?.latest;
  const isValidSource = source !== null && source !== undefined && source >= 0 && source <= 218;
  const showSourceTag = isValidSource && (pressure.via_sensor ?? "").toLowerCase() !== "source";
  return showSourceTag ? ["Source (P3)"] : [];
}

type CardSummary = {
  health: HealthTone;
  badgeLabel: string;
  primaryLine: string;
  secondaryLine?: string | null;
  signalLabel?: string | null;
  signalScore?: number | null;
};

function resolvePrimaryNetwork(diag: { wifi?: WifiDiagnostic | null; cellular?: CellularDiagnostic | null; satellite?: SatelliteDiagnostic | null; ethernet?: EthernetDiagnostic | null }): "wifi" | "cellular" | "ethernet" | null {
  if (diag.satellite?.default_via_eth0 === true) return "ethernet";
  if (diag.satellite?.default_via_wlan0 === true || diag.wifi?.default_via_wlan0 === true) return "wifi";
  if (diag.satellite?.default_via_wwan0 === true) return "cellular";

  const active = (diag.wifi?.connman_active_service || diag.cellular?.connman_active_service || diag.satellite?.connman_active_service || "").toLowerCase();
  if (active.includes("eth")) return "ethernet";
  if (active.includes("wlan") || active.includes("wifi")) return "wifi";
  if (active.includes("wwan") || active.includes("cell")) return "cellular";

  if (diag.ethernet?.internet_reachable) return "ethernet";
  if (diag.wifi?.connected || diag.wifi?.connman_wifi_connected) return "wifi";
  if (diag.cellular?.connman_cell_connected) return "cellular";
  return null;
}

function resolveRole(network: "wifi" | "cellular" | "ethernet", primary: "wifi" | "cellular" | "ethernet" | null, connected: boolean): string | null {
  if (!connected) return "Inactive";
  return primary === network ? "Primary" : "Backup";
}

function summarizeWifi(wifi?: WifiDiagnostic | null): CardSummary {
  if (!wifi) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  const connected = wifi.connected === true
    || wifi.connman_wifi_connected === true
    || wifi.internet_reachable === true;
  const ssid = wifi.ssid || wifi.access_point || "Wi-Fi";
  if (!connected) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "Not connected", secondaryLine: ssid };
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
  if (cell.qcsq === "NOSERVICE") return { health: "error", badgeLabel: "Issue", primaryLine: "No service" };
  // Resolve MCC-MNC codes (e.g. "311480") to human names ("Verizon") for display.
  // operator_name from +COPS AT command is authoritative; basic_provider/provider_code
  // from earlier commands may still carry the raw numeric code.
  const carrier = cell.operator_name
    || resolveCarrierCode(cell.basic_provider)
    || resolveCarrierCode(cell.provider_code)
    || "Cellular";
  // internet_reachable is set by cellular-check (authoritative connectivity test).
  // Use it as a fallback for connman connection state, which arrives later in the
  // diagnostic output and may still be null during streaming.
  const connected = cell.connman_cell_connected === true || cell.internet_reachable === true;
  const sig = signalLabel(cell.strength_score);
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
  const internetPassed = ethernet.check_result === "Success" && ethernet.internet_reachable === true;
  if (internetPassed) return { health: "healthy", badgeLabel: "Healthy", primaryLine: "Connected", secondaryLine: "Internet reachable" };
  if (ethernet.link_detected === false) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "No link detected" };
  if (ethernet.flap_count > 0) return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Unstable link" };
  if (!ethernet.ip_address) return { health: "error", badgeLabel: "Issue", primaryLine: "Connected", secondaryLine: "No IP assigned" };
  return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Limited internet" };
}

function summarizePressure(pressure?: PressureDiagnostic | null): CardSummary {
  if (!pressure) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  const health = pressure.status === "red" ? "error" : pressure.status === "orange" ? "warning" : "healthy";
  const badgeLabel = pressure.status === "red" ? "Error" : pressure.status === "orange" ? "Warning" : "Healthy";
  const source = pressure.sensors?.source?.latest;
  const isValidSource = source !== null && source !== undefined && source >= 0 && source <= 218;
  const showSourceLine = isValidSource && (pressure.via_sensor ?? "").toLowerCase() !== "source";
  return {
    health,
    badgeLabel,
    primaryLine: pressure.display_psi !== null && pressure.display_psi !== undefined ? `${pressure.display_psi.toFixed(1)} PSI` : "—",
    secondaryLine: showSourceLine ? `${source!.toFixed(1)} PSI` : null,
  };
}

function summarizeSatellite(sat?: SatelliteDiagnostic | null): CardSummary {
  if (!sat) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  if (sat.modem_present === false) return { health: "error", badgeLabel: "Issue", primaryLine: "No satellite modem detected" };
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
  const collapsedRecommendation = !expanded && (health === "warning" || health === "error")
    ? (
      sections.find((s) => s.title.toLowerCase() === "recommended actions")?.rows[0]?.value
      ?? sections.find((s) => ["diagnostics", "next action"].includes(s.title.toLowerCase()))?.rows[0]?.value
      ?? sections.flatMap((s) => s.rows).find((row) => row.label.toLowerCase().includes("recommended action"))?.value
    )
    : null;

  return (
    <article className={`diag-card diag-card-${health} ${expanded ? "diag-card-open" : "diag-card-collapsed"} ${compact ? "diag-card-compact" : ""} ${emphasizeSecondaryLine ? "diag-card-equal-lines" : ""}`}>
      <div className="diag-card-head">
        <div className="diag-card-title-wrap">
          <span className="diag-card-icon" aria-hidden>{icon}</span>
          <span className="diag-card-title">
            {title}
          </span>
          {role ? <span className="diag-role-pill-inline">{role}</span> : null}
        </div>
        <div className="diag-card-head-right">
          <span className="diag-status-label">
            <span className={`diag-status-dot diag-status-${health}`} />
            <span>{statusLabel}</span>
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
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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
      {collapsedRecommendation && <div className="diag-card-collapsed-reco">⚠ {collapsedRecommendation}</div>}

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

export default function DiagnosticsTab() {
  const [diag, setDiag] = useState<DiagnosticState | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    wifi: false,
    cellular: false,
    satellite: false,
    ethernet: false,
    pressure: false,
    sim_picker: false,
  });
  const [cardUpdatedAt, setCardUpdatedAt] = useState<Record<string, string | null>>({
    wifi: null,
    cellular: null,
    satellite: null,
    ethernet: null,
    pressure: null,
    sim_picker: null,
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
  const [globalDiagTier, setGlobalDiagTier] = useState<"quick" | "full" | "no-satellite">("quick");

  useEffect(() => {
    invoke("start_log_watcher").catch(() => {});

    const id = setInterval(async () => {
      if (Date.now() < postClearUntilRef.current) return; // post-clear cooldown
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
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
        setDiag(state);
        setLastUpdated(state.last_updated ?? null);
      } catch {
        // best effort
      }
    }, 2000);

    return () => clearInterval(id);
  }, []);

  const showNoSessionBanner = useMemo(() => !diag?.session_has_data, [diag]);

  const wifi = diag?.wifi;
  const cellular = diag?.cellular;
  const satellite = diag?.satellite;
  const ethernet = diag?.ethernet;
  const pressure = diag?.pressure;
  const system = diag?.system;
  const simPicker = diag?.sim_picker;
  const wifiSummary = summarizeWifi(wifi);
  const cellularSummary = summarizeCellular(cellular);
  const satelliteSummary = summarizeSatellite(satellite);
  const ethernetSummary = summarizeEthernet(ethernet);
  const pressureSummary = summarizePressure(pressure);
  const primaryNetwork = resolvePrimaryNetwork({ wifi, cellular, satellite, ethernet });
  const wifiRole = resolveRole("wifi", primaryNetwork, !!(wifi?.connected || wifi?.connman_wifi_connected));
  const cellularRole = resolveRole("cellular", primaryNetwork, cellular?.connman_cell_connected === true);
  const ethernetRole = resolveRole("ethernet", primaryNetwork, !!(ethernet?.link_detected || ethernet?.internet_reachable));

  async function clearCards() {
    await invoke("stop_log_watcher").catch(() => {});
    postClearUntilRef.current = Date.now() + 3000;
    setDiag({
      wifi: null,
      cellular: null,
      satellite: null,
      ethernet: null,
      pressure: null,
      system: null,
      last_updated: null,
      session_has_data: false,
    });
    setLastUpdated(null);
    setSystemUpdatedAt(null);
    setCardUpdatedAt({ wifi: null, cellular: null, satellite: null, ethernet: null, pressure: null, sim_picker: null });
    prevCardsRef.current = { wifi: "", cellular: "", satellite: "", ethernet: "", pressure: "", sim_picker: "" };
    prevSystemRef.current = "";
    setCopiedCommandId(null);
    setSentCommandId(null);
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
    try {
      await invoke("send_input", { text: script });
      setSentCommandId(blockId);
      setTimeout(() => setSentCommandId((prev) => (prev === blockId ? null : prev)), 1400);
    } catch {
      // No active controller session — silent; user can still use Copy
    }
  }

  const safeSid = system?.sid && /^\d{8}$/.test(system.sid) ? system.sid : null;
  const safeVersion = system?.version && /^r\d+\.\d+/.test(system.version) ? system.version : null;
  const systemIdentity = [
    safeSid ? `SID ${safeSid}` : null,
    safeVersion ? `v${safeVersion}` : null,
    system?.release_date ? system.release_date : null,
  ].filter(Boolean).join(" · ");
  const globalDiagBlockId = globalDiagTier === "full"
    ? "full-diags"
    : globalDiagTier === "no-satellite"
      ? "full-diags-no-sat"
      : "networking-all";

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div className="diag-header-left">
          <h2>System Diagnostics</h2>
          {systemIdentity && <div className="diag-system-line">{systemIdentity}</div>}
          {systemUpdatedAt && <div className="diag-system-line">System updated {systemUpdatedAt}</div>}
          <div className="diag-header-toolbar">
            <div className="diag-global-tier-group" role="group" aria-label="Diagnostics mode">
              <button type="button" className={`diag-tier-btn ${globalDiagTier === "quick" ? "diag-tier-btn-active" : ""}`} onClick={() => setGlobalDiagTier("quick")}>Quick</button>
              <button type="button" className={`diag-tier-btn ${globalDiagTier === "full" ? "diag-tier-btn-active" : ""}`} onClick={() => setGlobalDiagTier("full")}>Full</button>
              <button type="button" className={`diag-tier-btn ${globalDiagTier === "no-satellite" ? "diag-tier-btn-active" : ""}`} onClick={() => setGlobalDiagTier("no-satellite")}>No satellite</button>
            </div>
            <button className="btn btn-secondary" onClick={() => copyDiagnosticBlock(globalDiagBlockId)}>
              {copiedCommandId === globalDiagBlockId ? "Copied" : "Copy"}
            </button>
            <button className="btn btn-secondary" onClick={() => sendDiagnosticBlock(globalDiagBlockId)}>
              {sentCommandId === globalDiagBlockId ? "Sent" : "Send"}
            </button>
          </div>
        </div>

        <div className="diag-header-right">
          <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
          <button className="btn btn-secondary" onClick={clearCards}>Clear</button>
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
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "wifi" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, wifi: null } : prev);
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
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "cellular" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, cellular: null } : prev);
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
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "satellite" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, satellite: null } : prev);
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
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "ethernet" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, ethernet: null } : prev);
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
          primaryLine={pressureSummary.primaryLine}
          secondaryLine={pressureSummary.secondaryLine}
          sections={buildPressureSections(pressure)}
          expanded={expanded.pressure}
          onToggle={() => setExpanded((p) => ({ ...p, pressure: !p.pressure }))}
          updatedAt={cardUpdatedAt.pressure}
          onCopyCommand={() => copyDiagnosticBlock("pressure")}
          copied={copiedCommandId === "pressure"}
          onSendCommand={() => sendDiagnosticBlock("pressure")}
          sent={sentCommandId === "pressure"}
          compact={pressureSummary.health === "neutral"}
          emphasizeSecondaryLine
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "pressure" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, pressure: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, pressure: null }));
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
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "sim_picker" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, sim_picker: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, sim_picker: null }));
          }}
        />
      </div>
    </section>
  );
}
