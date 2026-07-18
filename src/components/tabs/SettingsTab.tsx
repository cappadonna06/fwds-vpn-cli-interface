import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LogSettings {
  transcript_logging_enabled: boolean;
  log_dir: string;
  retention_days: number;
}

const isWindows =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

export default function SettingsTab() {
  const [settings, setSettings] = useState<LogSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<LogSettings>("get_log_settings")
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  async function toggleLogging(next: boolean) {
    setBusy(true);
    try {
      await invoke("set_transcript_logging", { enabled: next });
      setSettings((s) => (s ? { ...s, transcript_logging_enabled: next } : s));
    } catch {
      /* leave the previous state in place if the write failed */
    } finally {
      setBusy(false);
    }
  }

  const enabled = settings?.transcript_logging_enabled ?? false;
  const retentionDays = settings?.retention_days ?? 14;

  return (
    <div className="tab-content">
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="card-title">App transcript logging</div>

        <div className="settings-row">
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !settings}
              onChange={(e) => toggleLogging(e.target.checked)}
            />
            <span className="settings-switch-track" aria-hidden="true">
              <span className="settings-switch-thumb" />
            </span>
            <span className="settings-switch-label">{enabled ? "On" : "Off"}</span>
          </label>
          <span className={`settings-status ${enabled ? "on" : "off"}`}>
            {enabled
              ? "Writing app-managed transcripts to disk"
              : "App-managed transcripts are off"}
          </span>
        </div>

        <p className="settings-note">
          App-managed transcripts help support reconstruct a field session. They
          are kept in this app&rsquo;s private folder; secret values such as Wi-Fi
          passwords are redacted before writing; and files older than {retentionDays}
          days are removed automatically on launch.
        </p>

        {settings && (
          <div className="settings-path-row">
            <code className="settings-path">{settings.log_dir}</code>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => invoke("reveal_log_dir").catch(() => {})}
            >
              Reveal folder
            </button>
          </div>
        )}

        {isWindows && (
          <p className="settings-note settings-note-warn">
            PuTTY&rsquo;s SSH session log remains enabled on Windows because connection
            status and diagnostic cards require it. PuTTY writes that log directly,
            so typed credentials cannot be redacted by the app.
          </p>
        )}
      </div>
    </div>
  );
}
