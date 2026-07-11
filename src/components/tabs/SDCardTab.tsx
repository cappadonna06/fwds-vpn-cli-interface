import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SdTarget, FirmwareInfo, SdFlashPoll } from "../../types/sdcard";

type Step = "source" | "select" | "confirm" | "run";

// Internal firmware release location (Step 0 in the field guide).
const FIRMWARE_URL =
  "https://drive.google.com/drive/folders/1EqNYpwu-Dg_WrIMaYR5x3wytYcBgziQW";

// macOS TCC blocks raw-disk writes AND reads of protected folders like
// ~/Downloads (even as root) unless the app has Full Disk Access. Detect that
// specific failure so we can guide the user instead of showing a raw error.
function isPermissionError(detail?: string): boolean {
  if (!detail) return false;
  return /operation not permitted|permission denied|not permitted/i.test(detail);
}

const STEPS: { id: Step; label: string }[] = [
  { id: "source", label: "Firmware" },
  { id: "select", label: "SD card" },
  { id: "confirm", label: "Confirm" },
  { id: "run", label: "Write" },
];
const STEP_INDEX: Record<Step, number> = { source: 0, select: 1, confirm: 2, run: 3 };
const TERMINAL = new Set(["done", "failed", "cancelled"]);

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`;
}

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const isWindows =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

export default function SDCardTab() {
  const [step, setStep] = useState<Step>("source");
  const [showHelp, setShowHelp] = useState(false);

  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const [targets, setTargets] = useState<SdTarget[]>([]);
  const [listing, setListing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [hasListed, setHasListed] = useState(false);

  const [confirmChecked, setConfirmChecked] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [poll, setPoll] = useState<SdFlashPoll | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const startedAtRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const selectedTarget = targets.find((t) => t.id === selectedId) || null;

  // Poll backend while a write is running.
  useEffect(() => {
    if (step !== "run") return;
    let active = true;
    const tick = async () => {
      try {
        const p = await invoke<SdFlashPoll>("poll_sd_flash");
        if (!active) return;
        setPoll(p);
        if (TERMINAL.has(p.phase) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* ignore transient poll errors */
      }
    };
    tick();
    pollRef.current = setInterval(tick, 700);
    return () => {
      active = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [step]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    if (showLog && logEndRef.current) {
      logEndRef.current.scrollIntoView({ block: "end" });
    }
  }, [poll?.lines.length, showLog]);

  async function pickImage() {
    setPickError(null);
    try {
      const fw = await invoke<FirmwareInfo>("select_firmware_image");
      setFirmware(fw);
    } catch (e) {
      const msg = String(e);
      if (!/No file selected/i.test(msg)) setPickError(msg);
    }
  }

  async function refreshDisks() {
    setListing(true);
    setListError(null);
    try {
      const list = await invoke<SdTarget[]>("list_sd_targets");
      setTargets(list);
      if (selectedId && !list.some((t) => t.id === selectedId)) setSelectedId(null);
    } catch (e) {
      setListError(String(e));
      setTargets([]);
    } finally {
      setListing(false);
      setHasListed(true);
    }
  }

  function goSelect() {
    setStep("select");
    refreshDisks();
  }

  async function startWrite() {
    if (!firmware || !selectedTarget) return;
    setStartError(null);
    try {
      await invoke("start_sd_flash", {
        imagePath: firmware.path,
        deviceId: selectedTarget.id,
      });
      startedAtRef.current = Date.now();
      setPoll(null);
      setShowLog(false);
      setStep("run");
    } catch (e) {
      setStartError(String(e));
    }
  }

  async function doCancel() {
    setConfirmCancel(false);
    try {
      await invoke("cancel_sd_flash");
    } catch {
      /* ignore */
    }
  }

  function writeAnotherCard() {
    setConfirmChecked(false);
    setSelectedId(null);
    setPoll(null);
    goSelect();
  }

  function startOver() {
    setConfirmChecked(false);
    setSelectedId(null);
    setPoll(null);
    setFirmware(null);
    setStep("source");
  }

  const phase = poll?.phase ?? "preparing";
  const isTerminal = TERMINAL.has(phase);
  // Check the log lines too — the banner may carry a generic message while the
  // underlying "Operation not permitted" only appears in the writer's log.
  const permissionIssue =
    phase === "failed" &&
    (isPermissionError(poll?.detail) || (poll?.lines ?? []).some((l) => isPermissionError(l)));
  const percent = poll ? poll.percent : 0;
  const indeterminate = percent < 0 || phase === "preparing";
  const elapsed = startedAtRef.current ? (Date.now() - startedAtRef.current) / 1000 : 0;
  const eta =
    phase === "writing" && percent > 1 && percent < 100
      ? elapsed * ((100 - percent) / percent)
      : NaN;

  const currentIdx = STEP_INDEX[step];

  return (
    <div className="tab-content sd-tab">
      {/* Stepper */}
      <div className="sd-steps">
        {STEPS.map((s, i) => (
          <span key={s.id} style={{ display: "inline-flex", alignItems: "center" }}>
            {i > 0 && <span className="sd-step-sep">›</span>}
            <span
              className={`sd-step${i === currentIdx ? " active" : ""}${
                i < currentIdx ? " done" : ""
              }`}
            >
              <span className="sd-step-num">{i < currentIdx ? "✓" : i + 1}</span>
              {s.label}
            </span>
          </span>
        ))}
      </div>

      {/* Step 1 — Firmware */}
      {step === "source" && (
        <div className="card">
          <div className="card-title">Choose firmware image</div>
          <p className="sd-lede">
            Select the controller firmware image you downloaded (a{" "}
            <code>.img</code> or <code>.img.gz</code> file, usually in your Downloads
            folder).
          </p>

          <div className="sd-firmware-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" onClick={pickImage}>
              {firmware ? "Choose a different image…" : "Choose firmware image…"}
            </button>
            {firmware && (
              <span className="sd-pill">{firmware.compressed ? "compressed .gz" : "raw .img"}</span>
            )}
          </div>

          {firmware && (
            <div className="sd-firmware-selected">
              <div className="sd-firmware-name">{firmware.file_name}</div>
              <div className="sd-target-meta">{firmware.size_label} on disk</div>
            </div>
          )}
          {pickError && <div className="sd-warn" style={{ marginTop: 10 }}>{pickError}</div>}

          <button
            type="button"
            className="btn-link sd-help-toggle"
            onClick={() => setShowHelp((v) => !v)}
          >
            {showHelp ? "▾" : "▸"} Where do I download firmware?
          </button>
          {showHelp && (
            <div className="sd-help">
              <ol>
                <li>Open the internal firmware release location.</li>
                <li>
                  Download the file ending in <code>.img.gz</code> (tens of MB
                  compressed) — not the <code>.sha256sum</code> checksum file.
                </li>
                <li>Save it to Downloads, then choose it above.</li>
              </ol>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openUrl(FIRMWARE_URL).catch(() => {})}
              >
                Open firmware downloads ↗
              </button>
            </div>
          )}

          <div className="sd-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!firmware}
              onClick={goSelect}
            >
              Next: choose SD card →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — Select SD card */}
      {step === "select" && (
        <div className="card">
          <div className="card-title">Select the SD card</div>
          <p className="sd-lede">
            Insert your microSD card, then pick it below. Only removable cards are
            shown — your computer's own drive can't be selected.
          </p>

          <div className="sd-firmware-row" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={refreshDisks}
              disabled={listing}
            >
              {listing ? "Scanning…" : "↻ Refresh"}
            </button>
          </div>

          {listError && <div className="sd-warn">{listError}</div>}

          {!listError && targets.length === 0 && (
            <div className="sd-empty">
              {listing
                ? "Looking for SD cards…"
                : hasListed
                ? "No removable SD card found. Insert one and click Refresh."
                : "Click Refresh to scan for SD cards."}
            </div>
          )}

          {targets.length > 0 && (
            <div className="sd-target-list">
              {targets.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`sd-target${selectedId === t.id ? " selected" : ""}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className="sd-target-radio" />
                  <span className="sd-target-main">
                    <span className="sd-target-name">{t.name}</span>
                    <span className="sd-target-meta">
                      {t.bus || "Removable"} · {t.id}
                    </span>
                  </span>
                  <span className="sd-target-size">{t.size_label}</span>
                </button>
              ))}
            </div>
          )}

          {selectedTarget && (
            <div className="sd-warn" style={{ marginTop: 10 }}>
              ⚠ Everything on <b>{selectedTarget.name} ({selectedTarget.size_label})</b>{" "}
              will be erased.
            </div>
          )}

          <div className="sd-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep("source")}>
              ← Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedTarget}
              onClick={() => {
                setConfirmChecked(false);
                setStep("confirm");
              }}
            >
              Next: confirm →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Confirm */}
      {step === "confirm" && firmware && selectedTarget && (
        <div className="card">
          <div className="card-title">Confirm and write</div>

          <div className="sd-summary">
            <div className="sd-summary-row">
              <span className="sd-summary-label">Image</span>
              <span className="sd-summary-value">{firmware.file_name}</span>
            </div>
            <div className="sd-summary-row">
              <span className="sd-summary-label">SD card</span>
              <span className="sd-summary-value">
                {selectedTarget.name} · {selectedTarget.size_label} · {selectedTarget.id}
              </span>
            </div>
          </div>

          <div className="sd-warn" style={{ marginTop: 12 }}>
            This permanently erases the card. Make sure it's the right one — this
            can't be undone.
          </div>

          <label className="sd-confirm-check">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
            />
            I understand all data on {selectedTarget.name} ({selectedTarget.size_label})
            will be permanently erased.
          </label>

          {startError && <div className="sd-warn" style={{ marginTop: 10 }}>{startError}</div>}

          <div className="sd-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep("select")}>
              ← Back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!confirmChecked}
              onClick={startWrite}
            >
              Erase &amp; write
            </button>
          </div>
          <p className="sd-target-meta" style={{ marginTop: 8 }}>
            {isWindows
              ? "You'll be asked to allow the change (Windows will show a User Account Control prompt)."
              : "You'll be asked for your computer's administrator password."}
          </p>
        </div>
      )}

      {/* Step 4 — Run */}
      {step === "run" && (
        <div className="card sd-run-card">
          {!isTerminal && (
            <>
              <div className="card-title">{poll?.detail || "Preparing…"}</div>
              <div className={`sd-progress${indeterminate ? " indeterminate" : ""}`}>
                <div
                  className="sd-progress-fill"
                  style={indeterminate ? undefined : { width: `${Math.max(0, percent)}%` }}
                />
              </div>
              <div className="sd-progress-meta">
                <span>
                  {fmtBytes(poll?.bytes_done ?? 0)} written
                  {poll && poll.total_bytes > 0 ? ` of ${fmtBytes(poll.total_bytes)}` : ""}
                </span>
                <span>
                  {percent >= 0 ? `${percent.toFixed(0)}%` : ""}
                  {poll && poll.rate_bps > 0
                    ? ` · ${(poll.rate_bps / 1e6).toFixed(1)} MB/s`
                    : ""}
                  {!isNaN(eta) ? ` · ETA ${fmtEta(eta)}` : ""}
                </span>
              </div>
              <div className="sd-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === "done" && (
            <div className="sd-result">
              <div className="sd-success-icon">✓</div>
              <div className="sd-result-title">SD card ready</div>
              <div className="sd-target-meta">
                The card was written and verified. You can remove it now.
              </div>
              <div className="sd-actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn-secondary" onClick={writeAnotherCard}>
                  Write another card
                </button>
                <button type="button" className="btn btn-primary" onClick={startOver}>
                  Done
                </button>
              </div>
            </div>
          )}

          {phase === "failed" && (
            <div className="sd-result">
              <div className="sd-fail-icon">✕</div>
              <div className="sd-result-title">Write failed</div>
              <div className="sd-warn">{poll?.detail || "The write did not complete."}</div>
              {permissionIssue && (
                <div className="sd-fda">
                  <div className="sd-fda-title">macOS needs permission to write the card</div>
                  <p className="sd-fda-text">
                    macOS blocks reading protected folders (like Downloads) and writing to
                    disks until this app is granted <strong>Full Disk Access</strong>. This is
                    a one-time setup per computer.
                  </p>
                  <ol className="sd-fda-steps">
                    <li>Open Full Disk Access settings (button below).</li>
                    <li>
                      Turn on <strong>FWDS Controller Console</strong> in the list — click{" "}
                      <strong>+</strong> to add it if it isn't shown.
                    </li>
                    <li>Quit and reopen this app, then write the card again.</li>
                  </ol>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => invoke("open_fda_settings").catch(() => {})}
                  >
                    Open Full Disk Access settings
                  </button>
                </div>
              )}
              <div className="sd-actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowLog((v) => !v)}>
                  {showLog ? "Hide details" : "Show details"}
                </button>
                <button type="button" className="btn btn-primary" onClick={writeAnotherCard}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {phase === "cancelled" && (
            <div className="sd-result">
              <div className="sd-result-title">Write cancelled</div>
              <div className="sd-warn">
                The card is incomplete and won't boot. Re-write it before use.
              </div>
              <div className="sd-actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn-primary" onClick={writeAnotherCard}>
                  Start again
                </button>
              </div>
            </div>
          )}

          {showLog && poll && poll.lines.length > 0 && (
            <div className="log-pane sd-log">
              {poll.lines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}

          {!isTerminal && (
            <button
              type="button"
              className="btn-link sd-help-toggle"
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? "Hide log" : "Show log"}
            </button>
          )}
        </div>
      )}

      {confirmCancel && (
        <div className="modal-overlay" onClick={() => setConfirmCancel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Cancel the write?</div>
            <p className="modal-body">
              Stopping now leaves the card unbootable — you'll need to write it again
              before use.
            </p>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmCancel(false)}>
                Keep writing
              </button>
              <button type="button" className="btn btn-danger" onClick={doCancel}>
                Cancel write
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
