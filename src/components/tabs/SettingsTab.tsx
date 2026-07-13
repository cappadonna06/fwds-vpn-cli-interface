import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LogSettings {
  transcript_logging_enabled: boolean;
  log_dir: string;
  retention_days: number;
}

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
        <div className="card-title">Session transcript logging</div>

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
              ? "Writing plaintext transcripts to disk"
              : "No transcripts are written to disk"}
          </span>
        </div>

        <p className="settings-note">
          Transcripts help support reconstruct a field session. They are kept in
          this app&rsquo;s private folder (never the Desktop, which syncs to
          iCloud); secret values such as Wi-Fi passwords are redacted before
          writing; and files older than {retentionDays} days are removed
          automatically on launch.
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

        <p className="settings-note settings-note-warn">
          On Windows the console is PuTTY, which writes its own log that the app
          cannot redact — while logging is on, typed Wi-Fi credentials may be
          captured in it. Turn logging off to disable that entirely.
        </p>
      </div>
    </div>
  );
}
