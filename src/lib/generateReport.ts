import {
  ReportAction,
  ReportRecommendedAction,
  NetworkStatusRow,
  SessionReport,
} from "../types/report";

// ── Local types mirroring Rust DiagnosticState serialization ─────────────────

type DiagStatus = "unknown" | "grey" | "green" | "orange" | "red";

interface EthernetDiag {
  status: DiagStatus;
  summary: string;
  link_detected?: boolean | null;
  flap_count?: number;
}

interface WifiDiag {
  status: DiagStatus;
  summary: string;
  check_result?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
}

interface CellularDiag {
  status: DiagStatus;
  summary: string;
  connman_cell_connected?: boolean | null;
  pdp_active?: boolean | null;
  sim_inserted?: boolean | null;
  provider_code?: string | null;
  imsi?: string | null;
  operator_name?: string | null;
  strength_score?: number | null;
  modem_not_present?: boolean;
}

interface SatelliteDiag {
  status: DiagStatus;
  summary: string;
  loopback_test_ran?: boolean;
  loopback_test_success?: boolean | null;
}

interface SystemDiag {
  sid?: string | null;
  version?: string | null;
}

interface DiagnosticState {
  ethernet?: EthernetDiag | null;
  wifi?: WifiDiag | null;
  cellular?: CellularDiag | null;
  satellite?: SatelliteDiag | null;
  system?: SystemDiag | null;
}

interface AppState {
  controller_ip?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusEmoji(status: DiagStatus | string): string {
  return status === "green" ? "✓"
    : status === "orange" ? "⚠"
    : status === "red" ? "✗"
    : "—";
}

// ── generateActions ───────────────────────────────────────────────────────────

export function generateActions(
  diag: DiagnosticState,
  _appState: AppState,
): ReportAction[] {
  const actions: ReportAction[] = [];
  let id = 0;
  const mkId = () => String(++id);

  // Firmware — always include if version known
  if (diag.system?.version) {
    actions.push({
      id: mkId(),
      text: `Firmware verified → ${diag.system.version}`,
      dismissed: false,
    });
  }

  // TODO: wire to command history from watcher
  // Setup commands cannot be detected from diag state alone in v1.
  // Include only if the operator adds them manually.

  // Diagnostics run — include if any diag card is populated
  const diagRun: string[] = [];
  if (diag.ethernet) diagRun.push(`Ethernet ${statusEmoji(diag.ethernet.status)}`);
  if (diag.wifi) diagRun.push(`Wi-Fi ${statusEmoji(diag.wifi.status)}`);
  if (diag.cellular) diagRun.push(`Cellular ${statusEmoji(diag.cellular.status)}`);
  if (diag.satellite) diagRun.push(`Satellite ${statusEmoji(diag.satellite.status)}`);

  if (diagRun.length > 0) {
    actions.push({
      id: mkId(),
      text: `Diagnostics run — ${diagRun.join(" · ")}`,
      dismissed: false,
    });
  }

  return actions;
}

// ── generateNetworkRows ───────────────────────────────────────────────────────

export function generateNetworkRows(diag: DiagnosticState): NetworkStatusRow[] {
  const toStatus = (s?: DiagStatus | null): "green" | "orange" | "red" | "unknown" => {
    if (s === "green") return "green";
    if (s === "orange") return "orange";
    if (s === "red") return "red";
    return "unknown";
  };

  return [
    {
      interface: "Ethernet",
      status: toStatus(diag.ethernet?.status),
      summary: diag.ethernet?.summary ?? "Run ethernet diagnostics to populate",
    },
    {
      interface: "Wi-Fi",
      status: toStatus(diag.wifi?.status),
      summary: diag.wifi?.summary ?? "Run Wi-Fi diagnostics to populate",
    },
    {
      interface: "Cellular",
      status: toStatus(diag.cellular?.status),
      summary: diag.cellular?.summary ?? "Run cellular diagnostics to populate",
    },
    {
      interface: "Satellite",
      status: toStatus(diag.satellite?.status),
      summary: diag.satellite?.summary ?? "Run satellite diagnostics to populate",
    },
  ];
}

// ── generateRecommendedActions ────────────────────────────────────────────────

export function generateRecommendedActions(
  diag: DiagnosticState,
): ReportRecommendedAction[] {
  const actions: ReportRecommendedAction[] = [];
  let id = 0;
  const mkId = () => String(++id);

  // ── ETHERNET ──────────────────────────────────────────────────────────────
  if (diag.ethernet) {
    const eth = diag.ethernet;

    if (eth.status === "red" && (eth.flap_count ?? 0) > 3) {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Swap switch port",
        detail: `Link flapping detected — ${eth.flap_count} events. Force switch port speed or move to different port.`,
        dismissed: false, checked: false, custom: false,
      });
    } else if (eth.status === "red" && eth.link_detected === false) {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Check cable and switch port",
        detail: "No physical link detected. Verify cable is seated and switch port is active.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (eth.status === "orange") {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Check router upstream connectivity",
        detail: "Link is up but DNS or internet is failing. Issue is likely upstream of the controller.",
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // ── WI-FI ─────────────────────────────────────────────────────────────────
  if (diag.wifi) {
    const wifi = diag.wifi;

    if (wifi.status === "red" && wifi.check_result === "Failure") {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Verify SSID and password",
        detail: "Connection failed. Re-run setup-wifi to correct credentials.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (wifi.status === "red" && (wifi.strength_score ?? 100) < 40) {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Relocate router or add repeater",
        detail: `Signal critically weak — ${wifi.strength_score}/100. Controller may lose Wi-Fi intermittently.`,
        dismissed: false, checked: false, custom: false,
      });
    } else if (wifi.status === "orange" && (wifi.strength_score ?? 100) < 60) {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Check antenna placement or router proximity",
        detail: `Signal ${wifi.strength_score}/100 (${wifi.strength_label ?? "weak"}). Monitor for reliability issues.`,
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // ── CELLULAR ──────────────────────────────────────────────────────────────
  if (diag.cellular) {
    const cell = diag.cellular;

    if (cell.modem_not_present) {
      actions.push({
        id: mkId(), interface: "Cellular",
        text: "Check modem connection / seating",
        detail: "No modem detected. Verify modem board is seated, then reboot controller.",
        dismissed: false, checked: false, custom: false,
      });
    }

    const noService = !cell.connman_cell_connected && !cell.pdp_active;

    if (noService && !cell.sim_inserted) {
      actions.push({
        id: mkId(), interface: "Cellular",
        text: "Check SIM card is seated correctly",
        detail: "Modem detected but SIM not found. Reseat SIM or try a known-good SIM.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (noService && cell.sim_inserted) {
      const isUSCell =
        cell.provider_code?.startsWith("31127") ||
        cell.imsi?.startsWith("311270") ||
        cell.operator_name === "US Cellular";

      if (isUSCell) {
        actions.push({
          id: mkId(), interface: "Cellular",
          text: "Consider Verizon SIM swap",
          detail: "US Cellular SIM detected — limited rural coverage. Verizon SIM may resolve no-service.",
          dismissed: false, checked: false, custom: false,
        });
      }

      actions.push({
        id: mkId(), interface: "Cellular",
        text: "Check coverage area and antenna",
        detail: "SIM detected but no network service. Verify antenna connection and site coverage.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (cell.status === "orange" && (cell.strength_score ?? 100) < 50) {
      actions.push({
        id: mkId(), interface: "Cellular",
        text: "Check antenna connection and placement",
        detail: `Signal ${cell.strength_score}/100. Verify antenna is hand-tight and not obstructed.`,
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // ── SATELLITE ─────────────────────────────────────────────────────────────
  if (diag.satellite) {
    const sat = diag.satellite;

    if (sat.status === "red" && sat.loopback_test_success === false) {
      actions.push({
        id: mkId(), interface: "Satellite",
        text: "Check antenna cabling and sky view",
        detail: "Loopback test failed. Verify N-type connector is hand-tight, cable has no sharp bends, and antenna has clear unobstructed sky view.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (sat.status === "orange" && !sat.loopback_test_ran) {
      actions.push({
        id: mkId(), interface: "Satellite",
        text: "Run satellite-check -t to verify connectivity",
        detail: "Satellite configured but loopback not yet tested this session.",
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // Sort: red issues first, then orange
  return actions.sort((a, b) => {
    const priority = (action: ReportRecommendedAction): number => {
      if (action.custom) return 2;
      const diagMap: Record<string, DiagStatus | undefined> = {
        Ethernet: diag.ethernet?.status,
        "Wi-Fi": diag.wifi?.status,
        Cellular: diag.cellular?.status,
        Satellite: diag.satellite?.status,
      };
      const status = diagMap[action.interface];
      return status === "red" ? 0 : status === "orange" ? 1 : 2;
    };
    return priority(a) - priority(b);
  });
}

// ── formatSlack ───────────────────────────────────────────────────────────────

export function formatSlack(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`*Controller Session — ${report.date}*`);
  lines.push(`*SID:* ${report.sid || "—"} · ${report.version || "—"} · ${report.ip || "—"}`);
  lines.push("");

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    lines.push("*Actions*");
    visibleActions.forEach(a => lines.push(`• ${a.text}`));
    lines.push("");
  }

  lines.push("*Network*");
  report.networkRows.forEach(row => {
    const dot = row.status === "green" ? "🟢"
      : row.status === "orange" ? "🟠"
      : row.status === "red" ? "🔴"
      : "⚪";
    const note = report.networkNotes[row.interface];
    const noteSuffix = note ? ` — ${note}` : "";
    lines.push(`• ${dot} ${row.interface}: ${row.summary}${noteSuffix}`);
  });
  lines.push("");

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    lines.push("*Recommended Actions*");
    visibleRecs.forEach(a => {
      const checkbox = a.checked ? "✓" : "☐";
      lines.push(`${checkbox} ${a.interface} — ${a.text}`);
      if (a.detail) lines.push(`  ${a.detail}`);
    });
    lines.push("");
  }

  if (report.notes.trim()) {
    lines.push("*Notes*");
    lines.push(report.notes.trim());
    lines.push("");
  }

  const outcomeLabel = report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";
  lines.push(`*Outcome:* ${outcomeLabel}`);

  return lines.join("\n");
}

// ── formatJira ────────────────────────────────────────────────────────────────

export function formatJira(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`h2. Controller Session — ${report.date}`);
  lines.push(`*SID:* ${report.sid || "—"} | *Firmware:* ${report.version || "—"} | *IP:* ${report.ip || "—"}`);
  lines.push("");

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    lines.push("h3. Actions");
    visibleActions.forEach(a => lines.push(`* ${a.text}`));
    lines.push("");
  }

  lines.push("h3. Network Status");
  lines.push("|| Interface || Status || Detail ||");
  report.networkRows.forEach(row => {
    const statusLabel = row.status === "green" ? "Connected"
      : row.status === "orange" ? "Warning"
      : row.status === "red" ? "Failed"
      : "No data";
    const note = report.networkNotes[row.interface];
    const detail = note ? `${row.summary} — ${note}` : row.summary;
    lines.push(`| ${row.interface} | ${statusLabel} | ${detail} |`);
  });
  lines.push("");

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    lines.push("h3. Recommended Actions");
    visibleRecs.forEach(a => {
      const done = a.checked ? " ✓ Done" : "";
      lines.push(`* ${a.interface} — ${a.text}${done}`);
      if (a.detail) lines.push(`** ${a.detail}`);
    });
    lines.push("");
  }

  if (report.notes.trim()) {
    lines.push("h3. Notes");
    lines.push(report.notes.trim());
    lines.push("");
  }

  const outcomeLabel = report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";
  lines.push(`*Outcome:* ${outcomeLabel}`);

  return lines.join("\n");
}
