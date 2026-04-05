export type ReportLineSource = "auto" | "preset" | "manual";

export type ReportLine = {
  id: string;
  text: string;
  source: ReportLineSource;
};

export type ReportSectionKey = "actions" | "diagnostics" | "recommendations";

export type ReportSection = {
  key: ReportSectionKey;
  title: string;
  lines: ReportLine[];
};

export type SessionReport = {
  sid?: string;
  timestamp?: string;
  firmware?: string;
  zones?: number;
  actions: ReportSection;
  diagnostics: ReportSection;
  recommendations: ReportSection;
};

export interface WifiDiagnostic {
  connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  ssid?: string | null;
  access_point?: string | null;
  strength_score?: number | null;
  internet_reachable?: boolean;
  check_result?: string;
  check_error?: string | null;
}

export interface CellularDiagnostic {
  connman_cell_connected?: boolean | null;
  connman_cell_powered?: boolean | null;
  connman_cell_ready?: boolean | null;
  strength_score?: number | null;
  operator_name?: string | null;
  basic_provider?: string | null;
  provider_code?: string | null;
  sim_inserted?: boolean | null;
  modem_present?: boolean | null;
  qcsq?: string | null;
  recommended_action?: string | null;
}

export interface SatelliteDiagnostic {
  modem_present?: boolean | null;
  loopback_test_ran?: boolean;
  loopback_test_success?: boolean | null;
  loopback_test_blocked_in_use?: boolean | null;
  satellites_seen?: number | null;
  total_time_seconds?: number | null;
}

export interface EthernetDiagnostic {
  internet_reachable?: boolean;
  link_detected?: boolean | null;
  ip_address?: string | null;
  speed?: string | null;
}

export interface SystemDiagnostic {
  sid?: string | null;
  version?: string | null;
}

export interface ReportAppState {
  wifi?: WifiDiagnostic | null;
  cellular?: CellularDiagnostic | null;
  satellite?: SatelliteDiagnostic | null;
  ethernet?: EthernetDiagnostic | null;
  system?: SystemDiagnostic | null;
  last_updated?: string | null;
}

export const ACTION_PRESETS = [
  "Firmware updated",
  "System configured",
  "Preferred network set",
  "Diagnostics run",
  "Network reconfigured",
  "Controller rebooted",
] as const;

export const DIAGNOSTIC_PRESETS = [
  "Ethernet validated",
  "Wi-Fi validated",
  "Cellular validated",
  "Satellite validated",
  "Failover behavior checked",
] as const;

export const RECOMMENDATION_PRESETS = [
  "Improve Wi-Fi signal",
  "Relocate access point",
  "Verify Wi-Fi credentials",
  "Check Ethernet cable or switch",
  "Verify DHCP / network configuration",
  "Check cellular coverage or antenna",
  "Reseat or replace SIM card",
  "Verify APN / provisioning",
  "Improve satellite antenna placement",
  "Check satellite cabling",
  "Run satellite loopback test",
  "Reboot controller",
  "Update firmware",
] as const;

function mkId(prefix: string, key: string): string {
  return `${prefix}-${key}`;
}

function line(prefix: string, key: string, text: string, source: ReportLineSource = "auto"): ReportLine {
  return { id: mkId(prefix, key), text, source };
}

function signalLabel(score?: number | null): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "No service";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Good";
  if (score >= 25) return "Fair";
  if (score > 0) return "Weak";
  return "No service";
}

function normalizeServiceName(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDuration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function summarizePreferredNetwork(state: ReportAppState): string | null {
  if (state.ethernet?.internet_reachable) return "Ethernet";
  if ((state.wifi?.connected ?? false) || (state.wifi?.connman_wifi_connected ?? false)) return "Wi-Fi";
  if (state.cellular?.connman_cell_connected) return "Cellular";
  if (state.satellite?.loopback_test_success) return "Satellite";
  return null;
}

export function summarizeEthernet(diag?: EthernetDiagnostic | null): string {
  if (!diag) return "Ethernet: No diagnostics run";
  if (diag.link_detected === false) return "Ethernet: Not connected";
  if (diag.internet_reachable) {
    const speed = diag.speed?.toLowerCase().includes("1000") ? " · Gigabit" : "";
    return `Ethernet: Connected${speed}`;
  }
  if (diag.link_detected === true && !diag.ip_address) return "Ethernet: Connected, no IP";
  if (diag.link_detected === true && !diag.internet_reachable) return "Ethernet: Connected, no internet";
  return "Ethernet: Not connected";
}

export function summarizeWifi(diag?: WifiDiagnostic | null): string {
  if (!diag) return "Wi-Fi: No diagnostics run";
  const connected = diag.connected === true || diag.connman_wifi_connected === true;
  if (!connected) return "Wi-Fi: Not connected";
  const ssid = normalizeServiceName(diag.ssid) || normalizeServiceName(diag.access_point) || "Connected";
  return `Wi-Fi: ${ssid} · ${signalLabel(diag.strength_score)}`;
}

export function summarizeCellular(diag?: CellularDiagnostic | null): string {
  if (!diag) return "Cellular: No diagnostics run";
  if (diag.connman_cell_powered === false) return "Cellular: Disabled";
  if (diag.modem_present === false) return "Cellular: Modem not detected";
  if (diag.sim_inserted === false) return "Cellular: No SIM";
  if ((diag.qcsq ?? "").toUpperCase() === "NOSERVICE") return "Cellular: No service";
  if (diag.connman_cell_connected) {
    const carrier = normalizeServiceName(diag.operator_name)
      || normalizeServiceName(diag.basic_provider)
      || normalizeServiceName(diag.provider_code)
      || "Connected";
    return `Cellular: ${carrier} · ${signalLabel(diag.strength_score)}`;
  }
  if (diag.connman_cell_ready === true) return "Cellular: Searching for network";
  return "Cellular: No service";
}

export function summarizeSatellite(diag?: SatelliteDiagnostic | null): string {
  if (!diag) return "Satellite: No diagnostics run";
  if (diag.modem_present === false) return "Satellite: Modem not detected";
  if (diag.loopback_test_success === true) return `Satellite: Verified (${formatDuration(diag.total_time_seconds)})`;
  if (diag.loopback_test_blocked_in_use) return "Satellite: Loopback blocked (in use)";
  if (diag.loopback_test_ran && diag.loopback_test_success === false) return "Satellite: Loopback failed";
  if (diag.satellites_seen === 0) return "Satellite: No satellites visible";
  return "Satellite: Not validated";
}

function buildActionLines(state: ReportAppState): ReportLine[] {
  const lines: ReportLine[] = [];

  if (state.system?.version) {
    lines.push(line("actions", "firmware", `Firmware updated → ${state.system.version}`));
  }

  const preferred = summarizePreferredNetwork(state);
  if (preferred) {
    lines.push(line("actions", "preferred-network", `Preferred network set to ${preferred}`));
  }

  const hasAnyDiagnostics = Boolean(state.wifi || state.ethernet || state.cellular || state.satellite);
  if (hasAnyDiagnostics) {
    const checks = [
      `Wi-Fi ${state.wifi ? "✓" : "—"}`,
      `Ethernet ${state.ethernet ? "✓" : "—"}`,
      `Cellular ${state.cellular ? "✓" : "—"}`,
      `Satellite ${state.satellite ? "✓" : "—"}`,
    ].join(" ");
    lines.push(line("actions", "diag-run", `Diagnostics run — ${checks}`));
  }

  return lines;
}

function buildDiagnosticLines(state: ReportAppState): ReportLine[] {
  return [
    line("diagnostics", "ethernet", summarizeEthernet(state.ethernet)),
    line("diagnostics", "wifi", summarizeWifi(state.wifi)),
    line("diagnostics", "cellular", summarizeCellular(state.cellular)),
    line("diagnostics", "satellite", summarizeSatellite(state.satellite)),
  ];
}

function uniquePush(bucket: string[], value: string | null | undefined): void {
  if (!value) return;
  if (!bucket.some((item) => item.toLowerCase() === value.toLowerCase())) {
    bucket.push(value);
  }
}

export function buildAutoRecommendations(appState: ReportAppState): string[] {
  const recommendations: string[] = [];

  const wifiConnected = appState.wifi?.connected === true || appState.wifi?.connman_wifi_connected === true;
  if (wifiConnected && (appState.wifi?.strength_score ?? 0) > 0 && (appState.wifi?.strength_score ?? 0) < 25) {
    uniquePush(recommendations, "Improve Wi-Fi signal");
  }
  if (!wifiConnected && appState.wifi) {
    uniquePush(recommendations, "Verify Wi-Fi credentials or access point selection");
  }
  if (appState.wifi?.check_error) {
    uniquePush(recommendations, "Verify Wi-Fi credentials or access point selection");
  }

  if (appState.ethernet?.link_detected === false) {
    uniquePush(recommendations, "Check Ethernet cable or switch");
  }
  if (appState.ethernet?.link_detected === true && !appState.ethernet?.ip_address) {
    uniquePush(recommendations, "Verify DHCP / network configuration");
  }

  if ((appState.cellular?.qcsq ?? "").toUpperCase() === "NOSERVICE") {
    uniquePush(recommendations, "Check cellular coverage or antenna");
  }
  if (appState.cellular?.connman_cell_ready === true && !appState.cellular?.connman_cell_connected) {
    uniquePush(recommendations, "Move to known good coverage area");
  }
  if (appState.cellular?.sim_inserted === false) {
    uniquePush(recommendations, "Reseat or replace SIM card");
  }
  if (appState.cellular?.recommended_action) {
    uniquePush(recommendations, appState.cellular.recommended_action);
  }

  if (appState.satellite?.loopback_test_ran !== true && appState.satellite) {
    uniquePush(recommendations, "Run satellite loopback test");
  }
  if (appState.satellite?.satellites_seen === 0) {
    uniquePush(recommendations, "Improve satellite antenna placement");
  }
  if (appState.satellite?.loopback_test_success === false) {
    uniquePush(recommendations, "Check satellite cabling and antenna position");
  }

  return recommendations;
}

export function buildAutoSessionReport(appState: ReportAppState): SessionReport {
  const timestamp = appState.last_updated ?? new Date().toISOString();
  const recommendations = buildAutoRecommendations(appState);

  return {
    sid: appState.system?.sid ?? undefined,
    timestamp,
    firmware: appState.system?.version ?? undefined,
    actions: {
      key: "actions",
      title: "Actions",
      lines: buildActionLines(appState),
    },
    diagnostics: {
      key: "diagnostics",
      title: "Network Diagnostics",
      lines: buildDiagnosticLines(appState),
    },
    recommendations: {
      key: "recommendations",
      title: "Recommended Actions / Follow-ups",
      lines: recommendations.map((item, idx) => line("recommendations", `${idx}`, item)),
    },
  };
}

function formatHeaderDate(timestamp?: string): string {
  if (!timestamp) return new Date().toISOString().slice(0, 10);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sectionText(title: string, lines: ReportLine[], bullet: boolean): string {
  const body = lines.length > 0
    ? lines.map((entry) => (bullet ? `- ${entry.text}` : entry.text)).join("\n")
    : bullet
      ? "- None"
      : "None";
  return `${title}:\n${body}`;
}

export function buildSlackSummary(report: SessionReport): string {
  const date = formatHeaderDate(report.timestamp);
  const sidPart = report.sid ? ` SID: ${report.sid}` : "";

  return [
    `Controller Session — ${date}${sidPart}`,
    "",
    sectionText(report.actions.title, report.actions.lines, false),
    "",
    sectionText(report.diagnostics.title, report.diagnostics.lines, false),
    "",
    sectionText(report.recommendations.title, report.recommendations.lines, false),
  ].join("\n");
}

export function buildJiraSummary(report: SessionReport): string {
  const date = formatHeaderDate(report.timestamp);

  return [
    `Controller Session — ${date}`,
    report.sid ? `SID: ${report.sid}` : "",
    "",
    sectionText(report.actions.title, report.actions.lines, true),
    "",
    sectionText(report.diagnostics.title, report.diagnostics.lines, true),
    "",
    sectionText(report.recommendations.title, report.recommendations.lines, true),
  ].filter(Boolean).join("\n");
}
