import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LogSettings {
  log_dir: string;
}

export default function SettingsTab() {
  const [settings, setSettings] = useState<LogSettings | null>(null);

  useEffect(() => {
    invoke<LogSettings>("get_log_settings")
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  return (
    <div className="tab-content">
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="card-title">Session privacy</div>

        <p className="settings-note">
          While you&rsquo;re connected to a controller, the console keeps a
          temporary transcript of the session so it can fill in the diagnostic
          cards. That file lives in the app&rsquo;s private folder and is erased
          the moment you disconnect or close the app. Nothing is kept between
          sessions, so anything you type during setup, including Wi-Fi
          passwords, is not stored on this computer.
        </p>

        <p className="settings-note">
          Need a copy of a session? Copy it from the terminal window while
          you&rsquo;re still connected.
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
      </div>
    </div>
  );
}
