import { useState } from "react";
import {
  type ControllerLED,
  type LEDColor,
  type LEDBehavior,
  type LEDSeverity,
  type LEDMeaning,
  colorsFor,
  behaviorsFor,
  meaningsFor,
  panelMeanings,
  LED_DISPLAY_NAME,
  LED_ALIAS,
  COLOR_DISPLAY_NAME,
  BEHAVIOR_DISPLAY_NAME,
} from "../../lib/ledDecoder";

// Emissive hardware-LED colors (verbatim from the web tool / iOS Brand.LED). These are the
// controller's real lenses, NOT UI accents — keep exactly as-is.
const LED = {
  green: "#27D965",
  amber: "#F7A911",
  red: "#FF3B30",
  blue: "#2E86FF",
  off: "#3A3E4D",
} as const;

function litColor(c: LEDColor): string {
  return LED[c];
}

// LED centers + radii in the faceplate SVG's coordinate space. The overlay <svg> shares the
// cropped viewBox, so these land exactly on the printed lenses. Active is the larger lens.
const FACEPLATE_VIEWBOX = "372 206 279 356";
const GEOM: Record<ControllerLED, { cx: number; cy: number; r: number }> = {
  ready: { cx: 407.7, cy: 234.1, r: 9.2 },
  online: { cx: 407.7, cy: 259.6, r: 9.2 },
  active: { cx: 407.7, cy: 293.7, r: 18 },
};

// severity -> css modifier class (defined in tabs.css)
const SEV: Record<LEDSeverity, string> = {
  nominal: "led-sev-good",
  info: "led-sev-info",
  advisory: "led-sev-warn",
  critical: "led-sev-bad",
};

type Tone = "good" | "warn" | "bad" | "neutral";

export default function LedDecoderTab() {
  const [readyColor, setReadyColor] = useState<LEDColor>("green");
  const [readyBehavior, setReadyBehavior] = useState<LEDBehavior>("solid");
  const [onlineColor, setOnlineColor] = useState<LEDColor>("green");
  const [onlineBehavior, setOnlineBehavior] = useState<LEDBehavior>("solid");
  const [activeBehavior, setActiveBehavior] = useState<LEDBehavior>("off");

  const sel = { readyColor, readyBehavior, onlineColor, onlineBehavior, activeBehavior };
  const panel = panelMeanings(sel);

  const perLED: Record<ControllerLED, LEDMeaning[]> = {
    ready: meaningsFor("ready", readyColor, readyBehavior),
    online: meaningsFor("online", onlineColor, onlineBehavior),
    active: meaningsFor("active", "blue", activeBehavior),
  };
  const unrecognized = (["ready", "online", "active"] as ControllerLED[]).filter(
    (l) => perLED[l].length === 0,
  );
  const status = overallStatus(panel, perLED, unrecognized);

  return (
    <div className="tab-content led-decoder-tab">
      <div className="led-heading">
        <span className="led-eyebrow">Tool</span>
        <h2 className="led-title">LED decoder</h2>
        <span className="badge badge-neutral">Read-only</span>
      </div>

      <div className="led-layout">
        {/* Left: the real controller faceplate, lenses flashing live. */}
        <div className="card led-faceplate-card">
          <div className="led-faceplate">
            <img
              src="/controller-led.svg"
              alt="Frontline Mark I controller faceplate"
              className="led-faceplate-img"
              draggable={false}
            />
            <svg
              viewBox={FACEPLATE_VIEWBOX}
              preserveAspectRatio="xMidYMid meet"
              className="led-faceplate-overlay"
              aria-hidden
            >
              <LedLens led="ready" color={readyColor} behavior={readyBehavior} />
              <LedLens led="online" color={onlineColor} behavior={onlineBehavior} />
              <LedLens led="active" color="blue" behavior={activeBehavior} />
            </svg>
          </div>
          <p className="led-faceplate-note">Live mock-up of the controller front panel.</p>
        </div>

        {/* Right: controls + decoded meaning. */}
        <div className="led-right">
          <div className="card">
            <div className="card-title">Set the lights</div>
            <div className="led-controls">
              <ControlRow led="ready" color={readyColor} behavior={readyBehavior} setColor={setReadyColor} setBehavior={setReadyBehavior} />
              <ControlRow led="online" color={onlineColor} behavior={onlineBehavior} setColor={setOnlineColor} setBehavior={setOnlineBehavior} />
              <ControlRow led="active" color="blue" behavior={activeBehavior} setColor={() => {}} setBehavior={setActiveBehavior} />
            </div>
          </div>

          <StatusBanner tone={status.tone} title={status.title} subtitle={status.subtitle} />

          {panel.length > 0 && (
            <div className="card">
              <div className="card-title">All three lights together</div>
              <div className="led-meaning-list">
                {panel.map((m, i) => (
                  <MeaningRow key={i} m={m} />
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-title">What this means</div>
            <div className="led-blocks">
              <MeaningBlock led="ready" color={readyColor} behavior={readyBehavior} meanings={perLED.ready} />
              <MeaningBlock led="online" color={onlineColor} behavior={onlineBehavior} meanings={perLED.online} />
              <MeaningBlock led="active" color="blue" behavior={activeBehavior} meanings={perLED.active} />
            </div>
          </div>

          <p className="led-footnote">
            Reference: front-panel status LEDs, rev 04. Active LED uses firmware 2.x and newer
            behavior. Pairing and startup patterns are added beyond the rev-04 table.
          </p>
        </div>
      </div>
    </div>
  );
}

// One flashing lens, drawn on top of the printed SVG lens at its exact coordinates. Verbatim.
function LedLens({ led, color, behavior }: { led: ControllerLED; color: LEDColor; behavior: LEDBehavior }) {
  const g = GEOM[led];
  const off = behavior === "off";
  const isAlt = behavior === "alternate";
  const isBlink = behavior === "blink" || behavior === "blinkSlow" || behavior === "blinkFast";
  const fill = isAlt ? LED.green : off ? LED.off : litColor(color);
  const anim =
    isAlt ? "fl-led-alt" : behavior === "blink" ? "fl-led-b2" : behavior === "blinkSlow" ? "fl-led-b1" : behavior === "blinkFast" ? "fl-led-b4" : undefined;
  const glow = off ? undefined : `drop-shadow(0 0 4px ${isAlt ? LED.amber : fill})`;
  return (
    <>
      {isBlink && <circle cx={g.cx} cy={g.cy} r={g.r} fill={LED.off} />}
      <circle cx={g.cx} cy={g.cy} r={g.r} fill={fill} className={anim} style={{ filter: glow }} />
    </>
  );
}

function ControlRow({
  led, color, behavior, setColor, setBehavior,
}: {
  led: ControllerLED; color: LEDColor; behavior: LEDBehavior;
  setColor: (c: LEDColor) => void; setBehavior: (b: LEDBehavior) => void;
}) {
  const showColor = colorsFor(led).length > 1 && behavior !== "alternate";
  return (
    <div className="led-control-row">
      <div className="led-control-name">
        <div className="led-control-title">{LED_DISPLAY_NAME[led]}</div>
        <div className="led-control-alias">{LED_ALIAS[led]} LED</div>
      </div>
      <div className="led-control-pickers">
        {showColor && (
          <Segmented options={colorsFor(led)} value={color} onChange={(v) => setColor(v as LEDColor)} labelOf={(v) => COLOR_DISPLAY_NAME[v as LEDColor]} />
        )}
        <Segmented options={behaviorsFor(led)} value={behavior} onChange={(v) => setBehavior(v as LEDBehavior)} labelOf={(v) => BEHAVIOR_DISPLAY_NAME[v as LEDBehavior]} />
      </div>
    </div>
  );
}

function Segmented({
  options, value, onChange, labelOf,
}: {
  options: string[]; value: string; onChange: (v: string) => void; labelOf: (v: string) => string;
}) {
  return (
    <div className="led-seg">
      {options.map((o) => {
        const on = o === value;
        return (
          <button key={o} type="button" onClick={() => onChange(o)} aria-pressed={on}
            className={`led-seg-btn${on ? " is-on" : ""}`}>
            {labelOf(o)}
          </button>
        );
      })}
    </div>
  );
}

function StatusBanner({ tone, title, subtitle }: { tone: Tone; title: string; subtitle: string }) {
  return (
    <div className={`led-banner led-tone-${tone}`}>
      <span className="led-banner-dot" aria-hidden />
      <div>
        <div className="led-banner-title">{title}</div>
        <div className="led-banner-sub">{subtitle}</div>
      </div>
    </div>
  );
}

function MeaningBlock({
  led, color, behavior, meanings,
}: {
  led: ControllerLED; color: LEDColor; behavior: LEDBehavior; meanings: LEDMeaning[];
}) {
  return (
    <div className="led-block">
      <div className="led-block-head">
        <span className="led-block-name">{LED_DISPLAY_NAME[led]}</span>
        <span className="led-block-caption">{caption(led, color, behavior)}</span>
      </div>
      {meanings.length === 0 ? (
        <div className="led-meaning led-sev-warn">
          <span className="led-dot" aria-hidden />
          <div>
            <div className="led-meaning-summary">Not a recognized state</div>
            <div className="led-meaning-detail">
              This isn&apos;t a documented controller pattern. Double-check what this light is actually doing.
            </div>
          </div>
        </div>
      ) : (
        <div className="led-meaning-list">
          {meanings.length > 1 && (
            <p className="led-multi-note">More than one possible cause. Most serious first.</p>
          )}
          {meanings.map((m, i) => (
            <MeaningRow key={i} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function MeaningRow({ m }: { m: LEDMeaning }) {
  return (
    <div className={`led-meaning ${SEV[m.severity]}`}>
      <span className="led-dot" aria-hidden />
      <div>
        <div className="led-meaning-summary">{m.summary}</div>
        {m.detail && <div className="led-meaning-detail">{m.detail}</div>}
      </div>
    </div>
  );
}

function caption(led: ControllerLED, color: LEDColor, behavior: LEDBehavior): string {
  if (behavior === "alternate") return "Green / amber alternating";
  if (behavior === "off") return "Off";
  if (led === "active") return BEHAVIOR_DISPLAY_NAME[behavior];
  return `${COLOR_DISPLAY_NAME[color]} · ${BEHAVIOR_DISPLAY_NAME[behavior]}`;
}

function overallStatus(
  panel: LEDMeaning[],
  perLED: Record<ControllerLED, LEDMeaning[]>,
  unrecognized: ControllerLED[],
): { tone: Tone; title: string; subtitle: string } {
  const all = [...panel, ...perLED.ready, ...perLED.online, ...perLED.active];
  if (all.some((m) => m.severity === "critical")) {
    return { tone: "bad", title: "Fault detected", subtitle: "One or more LEDs indicate a fault. Review below." };
  }
  if (unrecognized.length > 0) {
    const names = unrecognized.map((l) => LED_DISPLAY_NAME[l]).join(" and ");
    const plural = unrecognized.length > 1;
    return {
      tone: "warn",
      title: plural ? "Are these right?" : "Is this right?",
      subtitle: `The ${names} ${plural ? "lights aren't" : "light isn't"} a recognized controller state. Double-check the panel.`,
    };
  }
  if (panel.length > 0) {
    return { tone: "warn", title: panel[0].summary, subtitle: "Read from all three lights together. See below." };
  }
  if (all.some((m) => m.severity === "advisory")) {
    return { tone: "warn", title: "Needs attention", subtitle: "An LED is showing an advisory state." };
  }
  if (all.length === 0) {
    return { tone: "neutral", title: "No reading", subtitle: "Set the lights to match the controller." };
  }
  return { tone: "good", title: "Looks healthy", subtitle: "The selected lights decode to normal operation." };
}
