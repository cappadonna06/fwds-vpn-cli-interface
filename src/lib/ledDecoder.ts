// ledDecoder.ts — pure decode tables for the controller's three front-panel status
// LEDs (Ready / Online / Active). A faithful port of the iOS app's
// FrontlineKit/Sources/SetupReference/LEDDecoder.swift. Source of truth:
// Docs/reference/architecture/Controller LED Decoder v04.docx (rev 04), plus the two
// app-added whole-panel/pairing states noted below.
//
// Transport- and UI-agnostic: maps a (LED, color, behavior) selection to the meanings
// the firmware assigns it. Keep in sync with the Swift decoder.

export type ControllerLED = "ready" | "online" | "active";
export type LEDColor = "green" | "amber" | "red" | "blue";
// Ready/Online blink at a single 2 Hz rate (`blink`); Active distinguishes 4 Hz
// (`blinkFast`) from 1 Hz (`blinkSlow`); `alternate` is the bi-color green↔amber pattern.
export type LEDBehavior = "off" | "solid" | "blink" | "blinkSlow" | "blinkFast" | "alternate";
export type LEDSeverity = "nominal" | "info" | "advisory" | "critical";

export interface LEDMeaning {
  summary: string;
  detail?: string;
  severity: LEDSeverity;
  // Future: an SOP to link to when this meaning indicates a problem. sopID?: string;
}

export const LED_DISPLAY_NAME: Record<ControllerLED, string> = {
  ready: "Ready",
  online: "Online",
  active: "Active",
};

// The engineering alias the firmware/docs use.
export const LED_ALIAS: Record<ControllerLED, string> = {
  ready: "State",
  online: "Network",
  active: "Zone",
};

export const COLOR_DISPLAY_NAME: Record<LEDColor, string> = {
  green: "Green",
  amber: "Amber",
  red: "Red",
  blue: "Blue",
};

export const BEHAVIOR_DISPLAY_NAME: Record<LEDBehavior, string> = {
  off: "Off",
  solid: "Solid",
  blink: "Blinking",
  blinkSlow: "Slow blink",
  blinkFast: "Fast blink",
  alternate: "Alternating",
};

// MARK: Picker options (hardware-accurate per LED)

/** Colors this LED can actually display. */
export function colorsFor(led: ControllerLED): LEDColor[] {
  return led === "active" ? ["blue"] : ["green", "amber", "red"];
}

/** Behaviors this LED can actually show. Ready adds `alternate` (pairing). */
export function behaviorsFor(led: ControllerLED): LEDBehavior[] {
  switch (led) {
    case "ready":
      return ["off", "solid", "blink", "alternate"];
    case "online":
      return ["off", "solid", "blink"];
    case "active":
      return ["off", "solid", "blinkFast", "blinkSlow"];
  }
}

/** Blink frequency in Hz for the mock-up, or null when the lens isn't doing an
 *  on/off blink (off, solid, or the bi-color `alternate` swap). */
export function blinkHz(behavior: LEDBehavior): number | null {
  switch (behavior) {
    case "blink":
      return 2;
    case "blinkSlow":
      return 1;
    case "blinkFast":
      return 4;
    default:
      return null;
  }
}

// MARK: Decode (rev 04)

/** All meanings the firmware assigns to this LED state, most serious first. Active
 *  ignores `color` (it is blue only). An undefined combination returns []. */
export function meaningsFor(led: ControllerLED, color: LEDColor | null, behavior: LEDBehavior): LEDMeaning[] {
  switch (led) {
    case "ready":
      return readyMeanings(color, behavior);
    case "online":
      return onlineMeanings(color, behavior);
    case "active":
      return activeMeanings(behavior);
  }
}

function readyMeanings(color: LEDColor | null, behavior: LEDBehavior): LEDMeaning[] {
  if (behavior === "alternate") {
    // Bi-color green↔amber. Not in rev-04: the commissioning (pairing) pattern the
    // controller shows while its pairing window is open.
    return [
      {
        summary: "Pairing mode",
        detail:
          "Ready is alternating green and amber. The commissioning window is open and the controller is ready to pair.",
        severity: "info",
      },
    ];
  }
  if (color === "green" && behavior === "solid") {
    return [{ summary: "System operating normally", severity: "nominal" }];
  }
  if (color === "red" && behavior === "solid") {
    return [
      { summary: "Battery low", detail: "Power at or below 11.5V (20%). Battery running low.", severity: "critical" },
      {
        summary: "Supply pressure low",
        detail: "Supply under 20 PSI. Master valve issue or street pressure blockage.",
        severity: "critical",
      },
      {
        summary: "Low distribution pressure while active",
        detail: "Distribution pressure under 20 PSI during a run. Possible partial blockage.",
        severity: "critical",
      },
      { summary: "System starting up", detail: "Normal during boot.", severity: "info" },
    ];
  }
  if (color === "amber" && behavior === "solid") {
    return [
      {
        summary: "On backup battery",
        detail: "Power at or below 11.7V (30%). AC power lost, battery running low.",
        severity: "advisory",
      },
      {
        summary: "Freeze risk",
        detail: "Temperature under 35.6°F. Possible pipe freeze conditions.",
        severity: "advisory",
      },
      { summary: "Overheating", detail: "Temperature over 140°F.", severity: "advisory" },
    ];
  }
  if (color === "red" && behavior === "blink") {
    return [
      { summary: "Battery critical", detail: "Power at or below 11.3V (10%). Battery at critical level.", severity: "critical" },
      {
        summary: "No flow while active",
        detail: "System is active but no flow is detected. Possible blockage.",
        severity: "critical",
      },
    ];
  }
  if (color === "amber" && behavior === "blink") {
    return [{ summary: "Possible leak", detail: "Flow detected while the system is in Ready.", severity: "advisory" }];
  }
  return [];
}

function onlineMeanings(color: LEDColor | null, behavior: LEDBehavior): LEDMeaning[] {
  if (color === "green" && behavior === "solid") {
    return [{ summary: "Online with Frontline services", detail: "Fully logged in.", severity: "nominal" }];
  }
  if (color === "amber" && behavior === "solid") {
    return [
      {
        summary: "On satellite connection",
        detail: "Home internet and cellular unavailable, or running a satellite test.",
        severity: "advisory",
      },
    ];
  }
  if (color === "red" && behavior === "solid") {
    return [
      {
        summary: "Services unreachable",
        detail:
          "Connected to the internet but cannot reach Frontline services. Possible DNS or service failure.",
        severity: "critical",
      },
    ];
  }
  if (color === "red" && behavior === "blink") {
    return [
      {
        summary: "Offline",
        detail: "No internet and no services on any channel. Possible controller hang.",
        severity: "critical",
      },
    ];
  }
  return [];
}

// Active LED (Zone): blue only. Uses the firmware 2.x+ ("New") table.
function activeMeanings(behavior: LEDBehavior): LEDMeaning[] {
  switch (behavior) {
    case "off":
      return [{ summary: "System ready", detail: "Idle or inactive.", severity: "nominal" }];
    case "solid":
      return [
        {
          summary: "Active",
          detail: "Running hydration cycles, either spraying or resting between cycles.",
          severity: "info",
        },
      ];
    case "blinkFast":
      return [
        { summary: "Activating or deactivating", detail: "Transitioning between active and inactive.", severity: "info" },
      ];
    case "blinkSlow":
      return [
        { summary: "Draining", detail: "Drain and zone valves open for about 2 minutes (MP3 only).", severity: "info" },
      ];
    default:
      return [];
  }
}

// MARK: Whole-panel patterns (read from all three lights together)

export interface PanelSelection {
  readyColor: LEDColor;
  readyBehavior: LEDBehavior;
  onlineColor: LEDColor;
  onlineBehavior: LEDBehavior;
  activeBehavior: LEDBehavior;
}

/** Meanings that come from the COMBINATION of all three LEDs, not any single one. */
export function panelMeanings(sel: PanelSelection): LEDMeaning[] {
  const out: LEDMeaning[] = [];
  // Startup / reboot: Ready amber-solid + Online amber-solid + Active blue-solid.
  // Normal on power-up; if it never clears, the controller is stuck in a boot loop.
  if (
    sel.readyColor === "amber" &&
    sel.readyBehavior === "solid" &&
    sel.onlineColor === "amber" &&
    sel.onlineBehavior === "solid" &&
    sel.activeBehavior === "solid"
  ) {
    out.push({
      summary: "Starting up",
      detail:
        "This three-light pattern shows on power-up or reboot and should clear within a minute or two. If it stays like this, the controller is stuck in a boot loop, which needs attention.",
      severity: "advisory",
    });
  }
  return out;
}
