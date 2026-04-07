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
  detected_networks?: CopsNetwork[] | null;
  cops_scan_attempted?: boolean;
  cops_scan_completed?: boolean;
  cops_scan_failed?: boolean;
  cops_scan_empty?: boolean;
  best_network_code?: string | null;
  best_network_name?: string | null;
  nwscanmode?: number | null;
  sim_matches_detected?: boolean;
}

interface CopsNetwork {
  stat: number;
  long_name: string;
  numeric: string;
  act: number;
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

interface SystemDiagnostic {
  sid?: string | null;
  version?: string | null;
  release_date?: string | null;
}

interface DiagnosticState {
  wifi?: WifiDiagnostic | null;
  cellular?: CellularDiagnostic | null;
  satellite?: SatelliteDiagnostic | null;
  ethernet?: EthernetDiagnostic | null;
  system?: SystemDiagnostic | null;
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
  primaryLine: string;
  secondaryLine?: string | null;
  role?: string | null;
  signalLabel?: string | null;
  signalScore?: number | null;
  sections: DiagSection[];
  updatedAt?: string | null;
  expanded: boolean;
  onToggle: () => void;
  onCopyCommand?: () => void;
  copied?: boolean;
  compact?: boolean;
  onClear?: () => void;
  extraContent?: JSX.Element | null;
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

function signalLabel(score?: number | null): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "No service";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Good";
  if (score >= 25) return "Fair";
  if (score > 0) return "Weak";
  return "No service";
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
  const upper = v.toUpperCase();
  if (v === "0.0.0.0" || v === "—" || v === "-") return null;
  if (upper.startsWith("+")) return null;
  if (upper.includes("CGPADDR") || upper.includes("CGACT") || upper.includes("QCSQ")) return null;
  if (upper.startsWith("ERROR")) return null;
  return v;
}

function formatLoopback(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function resolve_carrier_ts(code: string): string {
  const verizon = ["311270", "311271", "311272", "311273", "311274", "311275", "311276", "311277", "311278", "311279", "311280", "311480", "311481", "311482", "311483", "311484", "311485", "311486", "311487", "311488", "311489"];
  const tmobile = ["310260", "310026", "310490", "310660", "312250", "310230", "310240", "310250"];
  const att = ["310410", "310380", "310980", "311180", "310030", "310560", "310680"];

  if (verizon.includes(code)) return "Verizon";
  if (tmobile.includes(code)) return "T-Mobile";
  if (att.includes(code)) return "AT&T";
  if (code === "313100") return "FirstNet (AT&T)";
  return `Carrier (${code})`;
}

function buildWifiSections(wifi?: WifiDiagnostic | null): DiagSection[] {
  if (!wifi) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

  const network: DiagRow[] = [
    { label: "Network", value: wifi.ssid || wifi.access_point || "Unknown" },
    { label: "Connection", value: wifi.connected === true ? "Connected" : "Not connected" },
    { label: "Signal", value: `${signalLabel(wifi.strength_score)}${wifi.signal_dbm !== null && wifi.signal_dbm !== undefined ? ` (${wifi.signal_dbm} dBm)` : ""}` },
    { label: "Role", value: wifi.default_via_wlan0 === true ? "Active" : wifi.connected === true ? "Backup" : "Inactive" },
    { label: "Speed", value: wifi.tx_bitrate_mbps !== null && wifi.tx_bitrate_mbps !== undefined ? `${wifi.tx_bitrate_mbps.toFixed(0)} Mbps` : "—" },
    { label: "Internet test", value: wifi.internet_reachable ? "Passed" : "Failed" },
  ];

  const action: DiagRow[] = [];
  if (wifi.check_error) action.push({ label: "Recommended action", value: "Check passphrase or AP selection" });
  else if ((wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25) action.push({ label: "Recommended action", value: "Monitor weak signal" });

  return [
    { title: "Network", rows: network },
    ...(action.length ? [{ title: "Next action", rows: action }] : []),
  ];
}

function buildCellularSections(cell?: CellularDiagnostic | null): DiagSection[] {
  if (!cell) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

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
      title: "Cellular",
      rows: [
        { label: "Carrier", value: cleanCellValue(cell.operator_name) || cleanCellValue(cell.provider_code) || cleanCellValue(cell.basic_provider) || "—" },
        { label: "Signal", value: signalLabel(cell.strength_score) + (cell.strength_score !== null && cell.strength_score !== undefined ? ` (${cell.strength_score}/100)` : "") },
        { label: "Connection", value: cell.connman_cell_connected === true ? "Connected" : "Not connected" },
        { label: "Role", value: roleLabel(cell.role) || "Inactive" },
        { label: "SIM", value: cell.sim_inserted === false ? "Missing" : cell.sim_ready === true ? "Ready" : "Unknown" },
        { label: "Modem", value: cell.modem_not_present ? "Not detected" : cell.modem_unreachable ? "Detected — not responding" : cell.cellular_disabled && cell.imei ? "Powered off (detected)" : cell.cellular_disabled ? "Powered off" : cell.modem_present === true ? cell.modem_model ?? "Detected" : "Unknown" },
        { label: "Network", value: [cell.rat, cell.band].filter(Boolean).join(" / ") || "—" },
        { label: "APN", value: cleanCellValue(cell.at_apn) || cleanCellValue(cell.basic_apn) || "—" },
      ],
    },
    {
      title: "Connectivity",
      rows: [
        { label: "Internet test", value: cell.internet_reachable ? "Passed" : "Failed" },
        { label: "Packet loss", value: `${cell.check_packet_loss_pct}%` },
        { label: "Latency", value: cell.check_avg_latency_ms !== null && cell.check_avg_latency_ms !== undefined ? `${cell.check_avg_latency_ms.toFixed(1)} ms` : "—" },
      ],
    },
    ...((primaryAction || otherOptions.length > 0) ? [{
      title: "Next action",
      rows: [
        ...(primaryAction ? [{ label: "Recommended action", value: primaryAction }] : []),
        ...(otherOptions.length > 0 ? [{ label: "Other options", value: otherOptions.join(" • ") }] : []),
      ],
    }] : []),
  ];
}

function buildSatelliteSections(sat?: SatelliteDiagnostic | null): DiagSection[] {
  if (!sat) return [{ title: "Status", rows: [{ label: "Status", value: "No diagnostics run" }, { label: "Last test", value: "—" }] }];

  const loopback =
    sat.loopback_test_success === true
      ? "Passed"
      : sat.loopback_test_ran
        ? sat.loopback_test_blocked_in_use
          ? "Blocked"
          : "Failed"
        : "Not run";

  const actions: DiagRow[] = [];
  if (!sat.loopback_test_ran && sat.modem_present === true) actions.push({ label: "Recommended action", value: "Run full satellite loopback test" });
  else if (sat.loopback_test_blocked_in_use) actions.push({ label: "Recommended action", value: "Retry test when interface is idle" });
  else if (sat.loopback_test_success === false) actions.push({ label: "Recommended action", value: "Check antenna placement and connection" });
  else if (sat.recommended_action) actions.push({ label: "Recommended action", value: sat.recommended_action });

  return [
    {
      title: "Satellite",
      rows: [
        { label: "Modem", value: sat.modem_present === true ? "Detected" : sat.modem_present === false ? "Not detected" : "Unknown" },
        { label: "Loopback", value: loopback },
        { label: "Visibility", value: sat.satellites_seen !== null && sat.satellites_seen !== undefined ? `${sat.satellites_seen} satellites` : "Not available" },
        { label: "Last test time", value: sat.loopback_test_success === true ? formatLoopback(sat.total_time_seconds) : "—" },
        { label: "Network state", value: sat.connman_state || "—" },
        { label: "Primary network", value: sat.connman_active_service || "—" },
      ],
    },
    ...(actions.length || sat.loopback_test_error || sat.light_test_error ? [{
      title: "Next action",
      rows: [
        ...actions,
        ...(sat.loopback_test_error ? [{ label: "Last error", value: sat.loopback_test_error }] : sat.light_test_error ? [{ label: "Last error", value: sat.light_test_error }] : []),
      ],
    }] : []),
  ];
}

function buildEthernetSections(ethernet?: EthernetDiagnostic | null): DiagSection[] {
  if (!ethernet) return [{ title: "Status", rows: [{ label: "Status", value: "Not diagnosed" }, { label: "Last test", value: "—" }] }];

  const connected = ethernet.internet_reachable || ethernet.link_detected === true;
  const actions: DiagRow[] = [];
  if (!ethernet.internet_reachable && ethernet.link_detected === false) actions.push({ label: "Recommended action", value: "Check cable or switch" });
  else if (!ethernet.ip_address) actions.push({ label: "Recommended action", value: "Check DHCP / static IP configuration" });
  else if (ethernet.flap_count > 0) actions.push({ label: "Recommended action", value: "Inspect link stability and port health" });

  return [
    {
      title: "Ethernet",
      rows: [
        { label: "Connection", value: connected ? "Connected" : "No link" },
        { label: "Speed", value: speedLabel(ethernet.speed) + (ethernet.duplex ? ` (${ethernet.duplex})` : "") },
        { label: "Role", value: connected ? "Connected path" : "Inactive" },
        { label: "Internet test", value: ethernet.internet_reachable ? "Passed" : "Failed" },
        { label: "Stability", value: ethernet.flap_count > 0 ? "Recent link flaps" : "Stable" },
      ],
    },
    ...(actions.length ? [{ title: "Next action", rows: actions }] : []),
  ];
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
  const connected = wifi.connected === true || wifi.connman_wifi_connected === true;
  const ssid = wifi.ssid || wifi.access_point || "Wi-Fi";
  if (!connected) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "Not connected", secondaryLine: ssid };
  const sig = signalLabel(wifi.strength_score);
  if ((wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25) {
    return { health: "warning", badgeLabel: "Warning", primaryLine: ssid, secondaryLine: "Monitoring recommended", signalLabel: sig, signalScore: wifi.strength_score };
  }
  if (!wifi.internet_reachable) {
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
  const carrier = cell.operator_name || cell.basic_provider || cell.provider_code || "Cellular";
  const connected = cell.connman_cell_connected === true;
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
  if (!ethernet) return { health: "neutral", badgeLabel: "Not diagnosed", primaryLine: "Not diagnosed" };
  if (ethernet.internet_reachable === true) return { health: "healthy", badgeLabel: "Healthy", primaryLine: "Connected", secondaryLine: "Internet reachable" };
  if (ethernet.link_detected === false) return { health: "neutral", badgeLabel: "Inactive", primaryLine: "No link detected" };
  if (ethernet.flap_count > 0) return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Unstable link" };
  if (!ethernet.ip_address) return { health: "error", badgeLabel: "Issue", primaryLine: "Connected", secondaryLine: "No IP assigned" };
  return { health: "warning", badgeLabel: "Warning", primaryLine: "Connected", secondaryLine: "Limited internet" };
}

function summarizeSatellite(sat?: SatelliteDiagnostic | null): CardSummary {
  if (!sat) return { health: "neutral", badgeLabel: "No data", primaryLine: "No data yet" };
  if (sat.modem_present === false) return { health: "error", badgeLabel: "Issue", primaryLine: "No satellite modem detected" };
  if (sat.loopback_test_success === true) return { health: "healthy", badgeLabel: "Verified", primaryLine: "Link verified" };
  if (sat.loopback_test_blocked_in_use) return { health: "warning", badgeLabel: "Warning", primaryLine: "Test blocked" };
  if (sat.loopback_test_ran && sat.loopback_test_success === false) return { health: "error", badgeLabel: "Issue", primaryLine: "Loopback failed" };
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

function renderSimPicker(cell?: CellularDiagnostic | null) {
  if (!cell || !(cell.no_service || cell.modem_unreachable) || !cell.cops_scan_attempted) return null;
  return (
    <div className="sim-picker">
      <div className="diag-section-label">SIM PICKER</div>
      {cell.cops_scan_failed && (
        <div className="sim-picker-state sim-picker-failed">
          <span className="sim-picker-icon">⚠</span>
          <div>
            <div className="sim-picker-headline">Network scan failed</div>
            <div className="sim-picker-detail">{cell.nwscanmode === 1 ? "Modem is in LTE-only mode — run setup-cellular to reset scan mode" : "Modem could not complete network scan — try rebooting controller"}</div>
          </div>
        </div>
      )}
      {cell.cops_scan_completed && cell.cops_scan_empty && (
        <div className="sim-picker-state sim-picker-empty">
          <span className="sim-picker-icon">📡</span>
          <div>
            <div className="sim-picker-headline">No networks detected</div>
            <div className="sim-picker-detail">No cellular signal at this location. Check antenna placement and sky view.</div>
          </div>
        </div>
      )}
      {cell.cops_scan_completed && !cell.cops_scan_empty && (
        <>
          <div className="sim-picker-networks">
            {(cell.detected_networks ?? []).map((net, i) => (
              <div key={`${net.numeric}-${i}`} className={`sim-picker-network sim-picker-network-${net.stat === 1 ? "available" : net.stat === 2 ? "current" : net.stat === 3 ? "detected" : "unknown"}`}>
                <span className="sim-picker-net-stat">{net.stat === 1 ? "●" : net.stat === 2 ? "✓" : "○"}</span>
                <span className="sim-picker-net-name">{resolve_carrier_ts(net.numeric)}</span>
                <span className="sim-picker-net-code">{net.numeric}</span>
                <span className="sim-picker-net-label">{net.stat === 1 ? "Available" : net.stat === 2 ? "Connected" : net.stat === 3 ? "Detected" : "Unknown"}</span>
              </div>
            ))}
          </div>
          <div className="sim-picker-installed">
            Installed SIM: {cell.basic_provider ?? cell.provider_code ?? "Verizon"} · {cell.sim_matches_detected ? "detected at this site" : "not detected at this site"}
          </div>
          {cell.best_network_name && !cell.sim_matches_detected && (
            <div className="sim-picker-recommendation">
              <span className="sim-picker-rec-label">RECOMMENDED SIM</span>
              <span className="sim-picker-rec-value">Install {cell.best_network_name} SIM</span>
              <span className="sim-picker-rec-detail">
                {(cell.detected_networks ?? []).find((n) => n.stat === 1)
                  ? `${cell.best_network_name} signal available at this location`
                  : `${cell.best_network_name} detected — install SIM to confirm service`}
              </span>
            </div>
          )}
          {cell.sim_matches_detected && (
            <div className="sim-picker-recommendation sim-picker-rec-mismatch">
              Installed SIM carrier is detectable but not attaching. Check APN configuration or reboot.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiagCard({
  title,
  icon,
  health,
  statusLabel,
  primaryLine,
  secondaryLine,
  role,
  signalLabel: cardSignalLabel,
  signalScore,
  sections,
  updatedAt,
  expanded,
  onToggle,
  onCopyCommand,
  copied,
  compact,
  onClear,
  extraContent,
}: DiagCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article className={`diag-card diag-card-${health} ${expanded ? "diag-card-open" : ""} ${compact ? "diag-card-compact" : ""}`}>
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
          {(onCopyCommand || onClear) && (
            <div className="diag-card-menu-wrap">
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
                  {onCopyCommand && (
                    <button
                      type="button"
                      className="diag-card-menu-item"
                      onClick={() => {
                        onCopyCommand();
                        setMenuOpen(false);
                      }}
                    >
                      {copied ? "Copied" : "Copy diagnostics commands"}
                    </button>
                  )}
                  {onCopyCommand && onClear && <div className="diag-card-menu-divider" />}
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

      <div className="diag-card-status-line">{primaryLine}</div>
      {secondaryLine && <div className="diag-card-secondary-line">{secondaryLine}</div>}
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
          {extraContent}
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
  });
  const [cardUpdatedAt, setCardUpdatedAt] = useState<Record<string, string | null>>({
    wifi: null,
    cellular: null,
    satellite: null,
    ethernet: null,
  });
  const prevCardsRef = useRef<Record<string, string>>({
    wifi: "",
    cellular: "",
    satellite: "",
    ethernet: "",
  });
  const prevSystemRef = useRef<string>("");
  const postClearUntilRef = useRef<number>(0);
  const [systemUpdatedAt, setSystemUpdatedAt] = useState<string | null>(null);
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);

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
  const system = diag?.system;
  const wifiSummary = summarizeWifi(wifi);
  const cellularSummary = summarizeCellular(cellular);
  const satelliteSummary = summarizeSatellite(satellite);
  const ethernetSummary = summarizeEthernet(ethernet);
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
      system: null,
      last_updated: null,
      session_has_data: false,
    });
    setLastUpdated(null);
    setSystemUpdatedAt(null);
    setCardUpdatedAt({ wifi: null, cellular: null, satellite: null, ethernet: null });
    prevCardsRef.current = { wifi: "", cellular: "", satellite: "", ethernet: "" };
    prevSystemRef.current = "";
    setCopiedCommandId(null);
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

  const safeSid = system?.sid && /^\d{8}$/.test(system.sid) ? system.sid : null;
  const safeVersion = system?.version && /^r\d+\.\d+/.test(system.version) ? system.version : null;
  const systemIdentity = [
    safeSid ? `SID ${safeSid}` : null,
    safeVersion ? `v${safeVersion}` : null,
    system?.release_date ? system.release_date : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div className="diag-header-left">
          <h2>System Diagnostics</h2>
          {systemIdentity && <div className="diag-system-line">{systemIdentity}</div>}
          {systemUpdatedAt && <div className="diag-system-line">System updated {systemUpdatedAt}</div>}
        </div>

        <div className="diag-header-right">
          <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
          <button className="btn btn-secondary" onClick={clearCards}>Clear</button>
        </div>
      </div>

      {showNoSessionBanner && (
        <div className="diag-empty">
          <div className="diag-empty-title">Run diagnostics</div>
          <div className="diag-empty-actions">
            <button className="btn btn-secondary" onClick={() => copyDiagnosticBlock("full-diags")}>
              {copiedCommandId === "full-diags" ? "Copied" : "Copy full diagnostics commands"}
            </button>
            <button className="btn btn-secondary" onClick={() => copyDiagnosticBlock("full-diags-no-sat")}>
              {copiedCommandId === "full-diags-no-sat" ? "Copied" : "Copy diagnostics (no satellite)"}
            </button>
          </div>
          <div className="diag-empty-sub">Use these commands in the terminal to populate system status.</div>
        </div>
      )}

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
          extraContent={renderSimPicker(cellular)}
          expanded={expanded.cellular}
          onToggle={() => setExpanded((p) => ({ ...p, cellular: !p.cellular }))}
          updatedAt={cardUpdatedAt.cellular}
          onCopyCommand={() => copyDiagnosticBlock("cellular")}
          copied={copiedCommandId === "cellular"}
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
          compact={ethernetSummary.health === "neutral"}
          onClear={async () => {
            await invoke("clear_diagnostic_interface", { interface: "ethernet" }).catch(() => {});
            setDiag(prev => prev ? { ...prev, ethernet: null } : prev);
            setCardUpdatedAt(prev => ({ ...prev, ethernet: null }));
          }}
        />
      </div>
    </section>
  );
}
