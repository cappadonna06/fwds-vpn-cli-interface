import { useState, useEffect, useRef, useCallback, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMMANDS,
  FAVORITE_COMMAND_IDS,
  DIAGNOSTIC_BLOCKS,
  ControllerCommand,
  CommandCategory,
  DiagnosticBlock,
} from "../../types/commands";

// TODO: wire to session log watcher
let _addRecentExternal: ((id: string) => void) | null = null;

export function addRecentCommand(id: string) {
  if (_addRecentExternal) {
    _addRecentExternal(id);
  }
}

type PaletteTab = "favorites" | "common" | "all";

const COMMON_CATEGORIES: CommandCategory[] = ["diagnostic", "info"];

function categoryLabel(cat: CommandCategory): string {
  return { config: "Config", diagnostic: "Diagnostic", info: "Info", system: "System" }[cat];
}

function formatSeconds(s: number): string {
  if (s < 60) return `~${s}s`;
  const m = Math.round(s / 60);
  return `~${m}m`;
}

function sumSeconds(ids: string[]): number {
  return ids.reduce((total, id) => {
    const c = COMMANDS.find((x) => x.id === id);
    return total + (c?.est_seconds ?? 0);
  }, 0);
}

type DiagSectionDef = {
  id: string;
  title: string;
  description: string;
  blockIds: string[];
  disabled?: boolean;
  placeholder?: string;
};

const DIAG_BLOCK_SECTIONS: DiagSectionDef[] = [
  {
    id: "all-diagnostics",
    title: "All diagnostics",
    description: "Complete system checks",
    blockIds: ["full-diags", "full-diags-no-sat"],
  },
  {
    id: "network",
    title: "Network",
    description: "Connectivity and interface checks",
    blockIds: ["networking-all", "ethernet", "wifi", "cellular", "satellite", "sim-picker"],
  },
  {
    id: "system",
    title: "System",
    description: "Firmware and controller identity",
    blockIds: ["system"],
  },
  {
    id: "hydraulics",
    title: "Hydraulics",
    description: "Not wired yet",
    blockIds: [],
    disabled: true,
    placeholder: "Coming soon: pump, pressure, manifold",
  },
];

const DIAG_BLOCK_TIME_TAGS: Record<string, string[]> = {
  wifi: ["15s"],
  cellular: ["30s"],
  ethernet: ["15s"],
  "networking-all": ["30s"],
  "full-diags": ["15m"],
  "full-diags-no-sat": ["45s"],
  satellite: ["1m", "15m"],
};

function resolveBlockScript(block: DiagnosticBlock, tier: "light" | "heavy"): string {
  const custom = tier === "light" ? block.light_script : block.heavy_script;
  if (custom && custom.trim().length > 0) return custom;
  const ids = tier === "light" ? block.light_command_ids : block.heavy_command_ids;
  return ids
    .map((id) => {
      const c = COMMANDS.find((x) => x.id === id);
      return c ? c.command : id;
    })
    .join("\n");
}

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ─── CommandRow ──────────────────────────────────────────────────────────────

interface CommandRowProps {
  cmd: ControllerCommand;
  /** Called for guard:none and guard:hard — parent handles clipboard or modal */
  onCopy: (cmd: ControllerCommand) => void;
  /** Called after the inline confirm banner is accepted (guard:confirm only) */
  onConfirmedCopy: (cmd: ControllerCommand) => void;
  onSend: (cmd: ControllerCommand) => void;
  onConfirmedSend: (cmd: ControllerCommand) => void;
  onOpenDrawer: (id: string) => void;
  isCopied: boolean;
  isSent: boolean;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  openDrawerId: string | null;
  searchQuery?: string;
}

function CommandRow({
  cmd,
  onCopy,
  onConfirmedCopy,
  onSend,
  onConfirmedSend,
  onOpenDrawer,
  isCopied,
  isSent,
  isFavorite,
  onToggleFavorite,
  openDrawerId,
  searchQuery = "",
}: CommandRowProps) {
  const isDrawerOpen = openDrawerId === cmd.id;
  const isDestructive = !!cmd.destructive;
  const [showBanner, setShowBanner] = useState(false);
  const [bannerAction, setBannerAction] = useState<"copy" | "send">("copy");

  function handleCopyClick() {
    if (cmd.guard === "confirm") {
      setBannerAction("copy");
      setShowBanner(true);
    } else {
      onCopy(cmd);
    }
  }

  function handleSendClick() {
    if (cmd.guard === "confirm") {
      setBannerAction("send");
      setShowBanner(true);
    } else {
      onSend(cmd);
    }
  }

  function handleBannerConfirm() {
    setShowBanner(false);
    if (bannerAction === "send") {
      onConfirmedSend(cmd);
    } else {
      onConfirmedCopy(cmd);
    }
  }

  return (
    <div className={`cmd-row ${isDestructive ? "cmd-row-destructive" : ""}`}>
      <button
        className="cmd-row-star"
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => onToggleFavorite(cmd.id)}
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        {isFavorite ? "★" : "☆"}
      </button>

      <div className="cmd-row-main">
        <div className="cmd-row-top">
          <code className="cmd-name">
            {searchQuery ? highlightMatch(cmd.label, searchQuery) : cmd.label}
          </code>
          {cmd.est_seconds !== undefined && (
            <span className="cmd-time-badge">{formatSeconds(cmd.est_seconds)}</span>
          )}
          <span className={`cmd-tag cmd-tag-category cmd-tag-${cmd.category}`}>
            {categoryLabel(cmd.category)}
          </span>
          {cmd.reboot_required && (
            <span className="cmd-tag cmd-tag-reboot">reboot</span>
          )}
          {isDestructive && (
            <span className="cmd-tag cmd-tag-danger">destructive</span>
          )}
        </div>
        <div className="cmd-desc">{cmd.description}</div>
        {showBanner && (
          <div className="cmd-inline-confirm">
            <span className="cmd-inline-confirm-msg">
              {cmd.guard_message ?? `Run ${cmd.command}?`}
            </span>
            <button
              className="btn btn-secondary cmd-inline-confirm-btn"
              onClick={() => setShowBanner(false)}
            >
              Cancel
            </button>
            <button
              className={`btn ${cmd.destructive ? "btn-danger" : "btn-primary"} cmd-inline-confirm-btn`}
              onClick={handleBannerConfirm}
            >
              {bannerAction === "send" ? "Send anyway" : "Copy anyway"}
            </button>
          </div>
        )}
      </div>

      <div className="cmd-row-actions">
        <button
          className={`cmd-copy-btn ${isCopied ? "cmd-copy-btn-copied" : ""}`}
          onClick={handleCopyClick}
          title="Copy command to clipboard"
        >
          {isCopied ? "✓ Copied" : "Copy"}
        </button>
        <button
          className={`cmd-copy-btn ${isSent ? "cmd-copy-btn-copied" : ""}`}
          onClick={handleSendClick}
          title="Send command to terminal"
        >
          {isSent ? "✓ Sent" : "Send"}
        </button>
        <button
          className={`cmd-chevron-btn ${isDrawerOpen ? "cmd-chevron-btn-open" : ""}`}
          onClick={() => onOpenDrawer(cmd.id)}
          title="Show command details"
          aria-label="Show details"
        >
          ▾
        </button>
      </div>
    </div>
  );
}

// ─── DiagnosticBlockRow ───────────────────────────────────────────────────────

interface DiagnosticBlockRowProps {
  block: DiagnosticBlock;
  onCopyLight: (block: DiagnosticBlock) => void;
  onCopyHeavy: (block: DiagnosticBlock) => void;
  onSendLight: (block: DiagnosticBlock) => void;
  onSendHeavy: (block: DiagnosticBlock) => void;
  copiedBlockId: string | null;
  sentBlockId: string | null;
  onOpenDrawer: (id: string) => void;
  isDrawerOpen: boolean;
}

function DiagnosticBlockRow({
  block,
  onCopyLight,
  onCopyHeavy,
  onSendLight,
  onSendHeavy,
  copiedBlockId,
  sentBlockId,
  onOpenDrawer,
  isDrawerOpen,
}: DiagnosticBlockRowProps) {
  const lightCopied = copiedBlockId === `${block.id}-light`;
  const heavyCopied = copiedBlockId === `${block.id}-heavy`;
  const singleCopied = copiedBlockId === `${block.id}-single`;
  const lightSent = sentBlockId === `${block.id}-light`;
  const heavySent = sentBlockId === `${block.id}-heavy`;
  const singleSent = sentBlockId === `${block.id}-single`;

  const hasDistinctTiers =
    block.light_command_ids.length > 0 &&
    block.heavy_command_ids.length > 0 &&
    JSON.stringify(block.light_command_ids) !== JSON.stringify(block.heavy_command_ids);

  const rows: Array<{
    label: string;
    copy: () => void;
    send: () => void;
    copied: boolean;
    sent: boolean;
  }> = [];
  if (hasDistinctTiers) {
    rows.push({
      label: "Light",
      copy: () => onCopyLight(block),
      send: () => onSendLight(block),
      copied: lightCopied,
      sent: lightSent,
    });
    rows.push({
      label: "Full",
      copy: () => onCopyHeavy(block),
      send: () => onSendHeavy(block),
      copied: heavyCopied,
      sent: heavySent,
    });
  } else {
    const label = block.id === "networking-all"
      ? "Light"
      : block.id === "full-diags"
        ? "Full"
        : block.id === "full-diags-no-sat"
          ? "No satellite"
          : "Full";
    rows.push({
      label,
      copy: () => onCopyHeavy(block),
      send: () => onSendHeavy(block),
      copied: singleCopied,
      sent: singleSent,
    });
  }

  return (
    <div className={`diag-block-row diag-block-tile ${isDrawerOpen ? "diag-block-row-open" : ""}`}>
      <div className="diag-block-icon">{block.icon}</div>
      <div className="diag-block-content">
        <div className="diag-block-header">
          <span className="diag-block-label">
            {block.label}
            {(DIAG_BLOCK_TIME_TAGS[block.id] ?? []).map((tag) => (
              <span key={`${block.id}-${tag}`} className="cmd-time-badge">~{tag}</span>
            ))}
          </span>
          <button
            className={`cmd-chevron-btn ${isDrawerOpen ? "cmd-chevron-btn-open" : ""}`}
            onClick={() => onOpenDrawer(block.id)}
            title="Block details"
            aria-label="Show block details"
          >
            ▾
          </button>
        </div>
        <div className="diag-block-desc">{block.description.split(".")[0]}.</div>
        <div className="diag-block-actions-stack">
          {rows.map((row) => (
            <div className="diag-block-actions" key={`${block.id}-${row.label}`}>
              <div className="diag-block-mode-label">
                <span>{row.label}</span>
              </div>
              <button
                className={`diag-block-btn ${row.copied ? "diag-block-btn-copied" : ""}`}
                onClick={row.copy}
              >
                {row.copied ? "✓ Copied" : "Copy"}
              </button>
              <button
                className={`diag-block-btn ${row.sent ? "diag-block-btn-copied" : ""}`}
                onClick={row.send}
              >
                {row.sent ? "✓ Sent" : "Send"}
              </button>
            </div>
          ))}
        </div>
      </div>
      {block.id === "full-diags" && (
        <div className="diag-block-warning">Runs satellite loopback test and can take up to 15 minutes.</div>
      )}
      {block.id === "satellite" && (
        <div className="diag-block-warning">Full satellite run includes loopback test and can take up to 15 minutes.</div>
      )}
    </div>
  );
}

// ─── DiagnosticBlockDrawer ────────────────────────────────────────────────────

interface DiagnosticBlockDrawerProps {
  block: DiagnosticBlock;
  allCommands: ControllerCommand[];
  onClose: () => void;
  onCopyLight: (block: DiagnosticBlock) => void;
  onCopyHeavy: (block: DiagnosticBlock) => void;
  onSendLight: (block: DiagnosticBlock) => void;
  onSendHeavy: (block: DiagnosticBlock) => void;
  copiedBlockId: string | null;
  sentBlockId: string | null;
}

function DiagnosticBlockDrawer({
  block,
  allCommands,
  onClose,
  onCopyLight,
  onCopyHeavy,
  onSendLight,
  onSendHeavy,
  copiedBlockId,
  sentBlockId,
}: DiagnosticBlockDrawerProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const hasDistinctTiers =
    block.light_command_ids.length > 0 &&
    block.heavy_command_ids.length > 0 &&
    JSON.stringify(block.light_command_ids) !== JSON.stringify(block.heavy_command_ids);

  const lightCopied = copiedBlockId === `${block.id}-light`;
  const heavyCopied = copiedBlockId === `${block.id}-heavy`;
  const singleCopied = copiedBlockId === `${block.id}-single`;
  const lightSent = sentBlockId === `${block.id}-light`;
  const heavySent = sentBlockId === `${block.id}-heavy`;
  const singleSent = sentBlockId === `${block.id}-single`;

  const lightTotal = sumSeconds(block.light_command_ids);
  const heavyTotal = sumSeconds(block.heavy_command_ids);

  function resolveCommands(ids: string[]): ControllerCommand[] {
    return ids
      .map((id) => allCommands.find((c) => c.id === id))
      .filter((c): c is ControllerCommand => c !== undefined);
  }

  const lightCmds = resolveCommands(block.light_command_ids);
  const heavyCmds = resolveCommands(block.heavy_command_ids);
  const lightScript = block.light_script;
  const heavyScript = block.heavy_script;

  function renderCommandList(cmds: ControllerCommand[]) {
    return (
      <div className="block-drawer-cmd-list">
        {cmds.map((c) => (
          <div key={c.id} className="block-drawer-cmd-item">
            <div className="block-drawer-cmd-top">
              <code className="cmd-name">{c.label}</code>
              {c.est_seconds !== undefined && (
                <span className="cmd-time-badge">{formatSeconds(c.est_seconds)}</span>
              )}
            </div>
            <div className="cmd-desc">{c.description}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="cmd-drawer-overlay" onClick={onClose} />
      <div className="cmd-drawer" role="dialog" aria-modal="true">
        <div className="cmd-drawer-header">
          <span className="block-drawer-title">
            <span className="block-drawer-title-icon">{block.icon}</span>
            {block.label}
          </span>
          <div className="cmd-drawer-header-actions">
            {block.time_warning && (
              <span className="cmd-drawer-guard-hint">⚠ {block.time_warning}</span>
            )}
            {hasDistinctTiers ? (
              <>
                <button
                  className={`cmd-copy-btn ${lightCopied ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onCopyLight(block)}
                >
                  {lightCopied ? "✓ Copied" : "Copy Light"}
                </button>
                <button
                  className={`cmd-copy-btn ${lightSent ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onSendLight(block)}
                >
                  {lightSent ? "✓ Sent" : "Send Light"}
                </button>
                <button
                  className={`cmd-copy-btn diag-block-btn-heavy ${heavyCopied ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onCopyHeavy(block)}
                >
                  {heavyCopied ? "✓ Copied" : "Copy Full"}
                </button>
                <button
                  className={`cmd-copy-btn diag-block-btn-heavy ${heavySent ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onSendHeavy(block)}
                >
                  {heavySent ? "✓ Sent" : "Send Full"}
                </button>
              </>
            ) : block.heavy_command_ids.length > 0 ? (
              <>
                <button
                  className={`cmd-copy-btn ${singleCopied ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onCopyHeavy(block)}
                >
                  {singleCopied ? "✓ Copied" : "Copy commands"}
                </button>
                <button
                  className={`cmd-copy-btn ${singleSent ? "cmd-copy-btn-copied" : ""}`}
                  onClick={() => onSendHeavy(block)}
                >
                  {singleSent ? "✓ Sent" : "Send commands"}
                </button>
              </>
            ) : null}
            <button className="cmd-drawer-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="cmd-drawer-sep" />
        <div className="cmd-drawer-body">
          <p className="cmd-drawer-description">{block.description}</p>

          {block.when_to_run && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">When to run</div>
              <div className="cmd-drawer-section-body">{block.when_to_run}</div>
            </div>
          )}

          {block.time_warning && (
            <div className="diag-block-warning" style={{ marginTop: 0 }}>
              {block.time_warning}
            </div>
          )}

          {/* If light === heavy or no light, show one combined section */}
          {!hasDistinctTiers && heavyCmds.length > 0 && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">
                Commands
                {heavyTotal > 0 && (
                  <span className="block-drawer-tier-time">{formatSeconds(heavyTotal)} total</span>
                )}
              </div>
              {renderCommandList(heavyCmds)}
              {heavyScript && <pre className="cmd-drawer-script">{heavyScript}</pre>}
            </div>
          )}

          {/* Light tier */}
          {hasDistinctTiers && lightCmds.length > 0 && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">
                Light tier
                {lightTotal > 0 && (
                  <span className="block-drawer-tier-time">{formatSeconds(lightTotal)} total</span>
                )}
              </div>
              {renderCommandList(lightCmds)}
              {lightScript && <pre className="cmd-drawer-script">{lightScript}</pre>}
            </div>
          )}

          {/* Full tier */}
          {hasDistinctTiers && heavyCmds.length > 0 && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">
                Full
                {heavyTotal > 0 && (
                  <span className="block-drawer-tier-time">{formatSeconds(heavyTotal)} total</span>
                )}
              </div>
              {renderCommandList(heavyCmds)}
              {heavyScript && <pre className="cmd-drawer-script">{heavyScript}</pre>}
            </div>
          )}

          {/* Full-diags: only heavy, no light */}
          {!hasDistinctTiers && block.light_command_ids.length === 0 && heavyCmds.length > 0 && null /* already rendered above */}
        </div>
      </div>
    </>
  );
}

// ─── CommandDrawer ────────────────────────────────────────────────────────────

interface CommandDrawerProps {
  cmd: ControllerCommand;
  allCommands: ControllerCommand[];
  onClose: () => void;
  onCopy: (cmd: ControllerCommand) => void;
  onSend: (cmd: ControllerCommand) => void;
  isCopied: boolean;
  isSent: boolean;
  onNavigate: (id: string) => void;
}

function CommandDrawer({
  cmd,
  allCommands,
  onClose,
  onCopy,
  onSend,
  isCopied,
  isSent,
  onNavigate,
}: CommandDrawerProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const relatedCmds = (cmd.related_command_ids ?? [])
    .map((id) => allCommands.find((c) => c.id === id))
    .filter((c): c is ControllerCommand => c !== undefined);

  return (
    <>
      <div className="cmd-drawer-overlay" onClick={onClose} />
      <div className="cmd-drawer" role="dialog" aria-modal="true">
        <div className="cmd-drawer-header">
          <code className="cmd-drawer-title">{cmd.label}</code>
          <div className="cmd-drawer-header-actions">
            {(cmd.guard === "confirm" || cmd.guard === "hard") && (
              <span className="cmd-drawer-guard-hint">
                {cmd.guard === "hard" ? "⚠ Destructive — confirmation required" : "⚠ Requires confirmation"}
              </span>
            )}
            <button
              className={`cmd-copy-btn ${isCopied ? "cmd-copy-btn-copied" : ""}`}
              onClick={() => onCopy(cmd)}
            >
              {isCopied ? "✓ Copied" : "Copy command"}
            </button>
            <button
              className={`cmd-copy-btn ${isSent ? "cmd-copy-btn-copied" : ""}`}
              onClick={() => onSend(cmd)}
            >
              {isSent ? "✓ Sent" : "Send command"}
            </button>
            <button className="cmd-drawer-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="cmd-drawer-sep" />
        <div className="cmd-drawer-body">
          <p className="cmd-drawer-description">{cmd.description}</p>

          {cmd.when_to_run && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">When to run</div>
              <div className="cmd-drawer-section-body">{cmd.when_to_run}</div>
            </div>
          )}

          {cmd.what_to_look_for && cmd.what_to_look_for.length > 0 && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">What to look for</div>
              <ul className="cmd-drawer-bullets">
                {cmd.what_to_look_for.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="cmd-drawer-meta">
            {cmd.est_seconds !== undefined && (
              <div className="cmd-drawer-meta-row">
                <span className="cmd-drawer-meta-label">Est. runtime</span>
                <span>{formatSeconds(cmd.est_seconds)}</span>
              </div>
            )}
            <div className="cmd-drawer-meta-row">
              <span className="cmd-drawer-meta-label">Category</span>
              <span>{categoryLabel(cmd.category)}</span>
            </div>
            <div className="cmd-drawer-meta-row">
              <span className="cmd-drawer-meta-label">Reboot needed</span>
              <span>{cmd.reboot_required ? "Yes" : "No"}</span>
            </div>
          </div>

          {relatedCmds.length > 0 && (
            <div className="cmd-drawer-section">
              <div className="cmd-drawer-section-title">Related commands</div>
              <div className="cmd-drawer-chips">
                {relatedCmds.map((rc) => (
                  <button
                    key={rc.id}
                    className="cmd-drawer-chip"
                    onClick={() => onNavigate(rc.id)}
                    title={rc.description}
                  >
                    <code>{rc.label}</code>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── ConfirmModal (guard: hard only) ─────────────────────────────────────────

interface ConfirmModalProps {
  cmd: ControllerCommand;
  onCancel: () => void;
  onConfirm: () => void;
  hardConfirmText: string;
  setHardConfirmText: (v: string) => void;
  action: "copy" | "send";
}

function ConfirmModal({
  cmd,
  onCancel,
  onConfirm,
  hardConfirmText,
  setHardConfirmText,
  action,
}: ConfirmModalProps) {
  const canConfirm = hardConfirmText === cmd.command;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Warning — Destructive Action</div>
        <div className="modal-body">{cmd.guard_message}</div>
        <div className="modal-hard-confirm">
          <label className="modal-hard-label">
            Type <code>{cmd.command}</code> to confirm:
          </label>
          <input
            type="text"
            value={hardConfirmText}
            onChange={(e) => setHardConfirmText(e.target.value)}
            placeholder={cmd.command}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && canConfirm) onConfirm();
            }}
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {action === "send" ? `Send ${cmd.command}` : `Copy ${cmd.command}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CommandsTab ──────────────────────────────────────────────────────────────

export default function CommandsTab() {
  const [search, setSearch] = useState("");
  const [paletteTab, setPaletteTab] = useState<PaletteTab>("favorites");
  const [openDrawerId, setOpenDrawerId] = useState<string | null>(null);
  const [openBlockDrawerId, setOpenBlockDrawerId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [sentBlockId, setSentBlockId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("fwds-favorite-commands");
      return stored ? (JSON.parse(stored) as string[]) : FAVORITE_COMMAND_IDS;
    } catch {
      return FAVORITE_COMMAND_IDS;
    }
  });
  const [recentlyUsed, setRecentlyUsed] = useState<string[]>([]);
  const [recentlyUsedOpen, setRecentlyUsedOpen] = useState(true);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<CommandCategory>>(new Set());
  const [hardConfirmCmd, setHardConfirmCmd] = useState<ControllerCommand | null>(null);
  const [hardConfirmText, setHardConfirmText] = useState("");
  const [hardConfirmAction, setHardConfirmAction] = useState<"copy" | "send">("copy");
  const [sendError, setSendError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // Register external recent-command adder
  useEffect(() => {
    _addRecentExternal = (id: string) => {
      setRecentlyUsed((prev: string[]) => {
        const filtered = prev.filter((x: string) => x !== id);
        return [id, ...filtered].slice(0, 5);
      });
    };
    return () => {
      _addRecentExternal = null;
    };
  }, []);

  // Persist favorites to localStorage
  useEffect(() => {
    localStorage.setItem("fwds-favorite-commands", JSON.stringify(favorites));
  }, [favorites]);

  // Auto-focus search when tab mounts
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleToggleFavorite = useCallback((id: string) => {
    setFavorites((prev: string[]) =>
      prev.includes(id) ? prev.filter((x: string) => x !== id) : [...prev, id]
    );
  }, []);

  function toggleCategory(cat: CommandCategory) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function doCopy(text: string, id: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev: string | null) => (prev === id ? null : prev)), 1500);
  }

  async function doSend(text: string, id: string) {
    try {
      await invoke("send_external_input", { text });
      setSentId(id);
      setTimeout(() => setSentId((prev: string | null) => (prev === id ? null : prev)), 1500);
      setSendError(null);
    } catch (e) {
      setSendError(String(e) || "Open session first");
    }
  }

  async function doSendBlock(text: string, key: string) {
    try {
      await invoke("send_external_input", { text });
      setSentBlockId(key);
      setTimeout(() => setSentBlockId((prev: string | null) => (prev === key ? null : prev)), 1500);
      setSendError(null);
    } catch (e) {
      setSendError(String(e) || "Open session first");
    }
  }

  // Called by CommandRow for guard:none and guard:hard
  function handleCopyFromRow(cmd: ControllerCommand) {
    if (cmd.guard === "hard") {
      setHardConfirmText("");
      setHardConfirmAction("copy");
      setHardConfirmCmd(cmd);
      return;
    }
    doCopy(cmd.command, cmd.id);
  }

  // Called by CommandRow after inline confirm banner accepted (guard:confirm)
  function handleConfirmedRowCopy(cmd: ControllerCommand) {
    doCopy(cmd.command, cmd.id);
  }

  // Called by CommandRow Send button
  function handleSendFromRow(cmd: ControllerCommand) {
    if (cmd.guard === "hard") {
      setHardConfirmText("");
      setHardConfirmAction("send");
      setHardConfirmCmd(cmd);
      return;
    }
    doSend(cmd.command, cmd.id);
  }

  // Called by CommandRow after inline confirm banner accepted for send
  function handleConfirmedRowSend(cmd: ControllerCommand) {
    doSend(cmd.command, cmd.id);
  }

  // Called by CommandDrawer Copy button — uses modal for both confirm and hard
  function handleCopyFromDrawer(cmd: ControllerCommand) {
    if (cmd.guard === "hard" || cmd.guard === "confirm") {
      setHardConfirmText("");
      setHardConfirmAction("copy");
      setHardConfirmCmd(cmd);
      return;
    }
    doCopy(cmd.command, cmd.id);
  }

  // Called by CommandDrawer Send button
  function handleSendFromDrawer(cmd: ControllerCommand) {
    if (cmd.guard === "hard" || cmd.guard === "confirm") {
      setHardConfirmText("");
      setHardConfirmAction("send");
      setHardConfirmCmd(cmd);
      return;
    }
    doSend(cmd.command, cmd.id);
  }

  function handleHardConfirm() {
    if (hardConfirmCmd) {
      if (hardConfirmAction === "send") {
        doSend(hardConfirmCmd.command, hardConfirmCmd.id);
      } else {
        doCopy(hardConfirmCmd.command, hardConfirmCmd.id);
      }
      setHardConfirmCmd(null);
      setHardConfirmText("");
      setHardConfirmAction("copy");
    }
  }

  function blockSendLight(block: DiagnosticBlock) {
    doSendBlock(resolveBlockScript(block, "light"), `${block.id}-light`);
  }

  function blockSendHeavy(block: DiagnosticBlock) {
    const hasDistinct =
      block.light_command_ids.length > 0 &&
      block.heavy_command_ids.length > 0 &&
      JSON.stringify(block.light_command_ids) !== JSON.stringify(block.heavy_command_ids);
    doSendBlock(resolveBlockScript(block, "heavy"), hasDistinct ? `${block.id}-heavy` : `${block.id}-single`);
  }

  // Opening a command drawer closes any block drawer, and vice versa
  function handleOpenCommandDrawer(id: string) {
    setOpenBlockDrawerId(null);
    setOpenDrawerId((prev: string | null) => (prev === id ? null : id));
  }

  function handleOpenBlockDrawer(id: string) {
    setOpenDrawerId(null);
    setOpenBlockDrawerId((prev: string | null) => (prev === id ? null : id));
  }

  function handleBlockCopy(block: DiagnosticBlock, tier: "light" | "heavy" | "single") {
    const scriptTier = tier === "light" ? "light" : "heavy";
    const text = resolveBlockScript(block, scriptTier);
    navigator.clipboard.writeText(text).catch(() => {});
    const key = tier === "single" ? `${block.id}-single` : `${block.id}-${tier}`;
    setCopiedBlockId(key);
    setTimeout(
      () => setCopiedBlockId((prev: string | null) => (prev === key ? null : prev)),
      1500
    );
  }

  function blockCopyLight(block: DiagnosticBlock) {
    handleBlockCopy(block, "light");
  }

  function blockCopyHeavy(block: DiagnosticBlock) {
    const hasDistinct =
      block.light_command_ids.length > 0 &&
      block.heavy_command_ids.length > 0 &&
      JSON.stringify(block.light_command_ids) !== JSON.stringify(block.heavy_command_ids);
    handleBlockCopy(block, hasDistinct ? "heavy" : "single");
  }

  // Determine displayed palette commands
  const isSearching = search.trim().length > 0;
  const q = search.trim().toLowerCase();

  function getFilteredCommands(): ControllerCommand[] {
    if (isSearching) {
      return COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.command.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          (c.tags ?? []).some((t: string) => t.toLowerCase().includes(q))
      );
    }
    if (paletteTab === "favorites") {
      return COMMANDS.filter((c) => favorites.includes(c.id));
    }
    if (paletteTab === "common") {
      return COMMANDS.filter((c) => COMMON_CATEGORIES.includes(c.category));
    }
    return COMMANDS;
  }

  const displayedCommands = getFilteredCommands();

  const recentCmds = recentlyUsed
    .map((id: string) => COMMANDS.find((c) => c.id === id))
    .filter((c): c is ControllerCommand => c !== undefined);

  const openDrawerCmd = openDrawerId
    ? COMMANDS.find((c) => c.id === openDrawerId) ?? null
    : null;

  const openBlockDrawer = openBlockDrawerId
    ? DIAGNOSTIC_BLOCKS.find((b) => b.id === openBlockDrawerId) ?? null
    : null;

  // Group for "all" tab
  const grouped: Partial<Record<CommandCategory, ControllerCommand[]>> = {};
  if (!isSearching && paletteTab === "all") {
    for (const cmd of displayedCommands) {
      grouped[cmd.category] = [...(grouped[cmd.category] ?? []), cmd];
    }
  }

  function renderRow(cmd: ControllerCommand) {
    return (
      <CommandRow
        key={cmd.id}
        cmd={cmd}
        onCopy={handleCopyFromRow}
        onConfirmedCopy={handleConfirmedRowCopy}
        onSend={handleSendFromRow}
        onConfirmedSend={handleConfirmedRowSend}
        onOpenDrawer={handleOpenCommandDrawer}
        isCopied={copiedId === cmd.id}
        isSent={sentId === cmd.id}
        isFavorite={favorites.includes(cmd.id)}
        onToggleFavorite={handleToggleFavorite}
        openDrawerId={openDrawerId}
      />
    );
  }

  return (
    <div className="commands-page">
      {/* Search bar */}
      <div className="commands-search-bar">
        <div className="commands-search-wrap">
          <span className="commands-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            className="commands-search-input"
            type="text"
            placeholder="Search commands…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search commands"
          />
          {search && (
            <button
              className="commands-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        {sendError && <div className="warning-item">⚠ {sendError}</div>}
      </div>

      {/* Body */}
      <div className="commands-body">
        {/* Left — palette */}
        <div className="commands-palette">
          {!isSearching && (
            <div className="palette-header">
              <div className="palette-tabs">
                {(["favorites", "common", "all"] as PaletteTab[]).map((t) => (
                  <button
                    key={t}
                    className={`palette-tab ${paletteTab === t ? "active" : ""}`}
                    onClick={() => setPaletteTab(t)}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="palette-list">
            {isSearching ? (
              displayedCommands.length === 0 ? (
                <div className="palette-empty">No commands match.</div>
              ) : (
                displayedCommands.map((cmd) => (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    onCopy={handleCopyFromRow}
                    onConfirmedCopy={handleConfirmedRowCopy}
                    onSend={handleSendFromRow}
                    onConfirmedSend={handleConfirmedRowSend}
                    onOpenDrawer={handleOpenCommandDrawer}
                    isCopied={copiedId === cmd.id}
                    isSent={sentId === cmd.id}
                    isFavorite={favorites.includes(cmd.id)}
                    onToggleFavorite={handleToggleFavorite}
                    openDrawerId={openDrawerId}
                    searchQuery={search.trim()}
                  />
                ))
              )
            ) : paletteTab === "favorites" ? (
              <>
                {recentCmds.length > 0 && (
                  <div className="recently-used-section">
                    <button
                      className="recently-used-header"
                      onClick={() => setRecentlyUsedOpen((o) => !o)}
                    >
                      <span className="recently-used-toggle">
                        {recentlyUsedOpen ? "▾" : "▸"}
                      </span>
                      Recently Used
                    </button>
                    {recentlyUsedOpen && recentCmds.map(renderRow)}
                  </div>
                )}
                {displayedCommands.length === 0 ? (
                  <div className="palette-empty">No favorites yet. Click ☆ on any command.</div>
                ) : (
                  displayedCommands.map(renderRow)
                )}
              </>
            ) : paletteTab === "common" ? (
              displayedCommands.length === 0 ? (
                <div className="palette-empty">No commands.</div>
              ) : (
                displayedCommands.map(renderRow)
              )
            ) : (
              // "all" tab — grouped with collapsible headers
              (["config", "diagnostic", "info", "system"] as CommandCategory[]).map((cat) =>
                grouped[cat]?.length ? (
                  <div key={cat} className="palette-group">
                    <button
                      className="palette-group-header"
                      onClick={() => toggleCategory(cat)}
                    >
                      <span className="palette-group-toggle">
                        {collapsedCategories.has(cat) ? "▸" : "▾"}
                      </span>
                      {categoryLabel(cat)}
                    </button>
                    {!collapsedCategories.has(cat) && grouped[cat]!.map(renderRow)}
                  </div>
                ) : null
              )
            )}
          </div>
        </div>

        {/* Right — diagnostic blocks */}
        <div className="commands-blocks">
          <div className="commands-blocks-heading">Diagnostics Blocks</div>
          <div className="diag-block-sections">
            {DIAG_BLOCK_SECTIONS.map((section) => {
              const blocks = section.blockIds
                .map((id) => DIAGNOSTIC_BLOCKS.find((b) => b.id === id))
                .filter((b): b is DiagnosticBlock => !!b);

              return (
                <section
                  key={section.id}
                  className={`diag-block-section ${section.disabled ? "diag-block-section-disabled" : ""}`}
                >
                  <div className="diag-block-section-head">
                    <h4>{section.title}</h4>
                    <p>{section.description}</p>
                  </div>
                  {section.disabled ? (
                    <div className="diag-block-placeholder">{section.placeholder}</div>
                  ) : (
                    <div className={`diag-block-grid ${section.id === "network" ? "diag-block-grid-network" : ""}`}>
                      {blocks.map((block) => (
                        <DiagnosticBlockRow
                          key={`${section.id}-${block.id}`}
                          block={block}
                          onCopyLight={blockCopyLight}
                          onCopyHeavy={blockCopyHeavy}
                          onSendLight={blockSendLight}
                          onSendHeavy={blockSendHeavy}
                          copiedBlockId={copiedBlockId}
                          sentBlockId={sentBlockId}
                          onOpenDrawer={handleOpenBlockDrawer}
                          isDrawerOpen={openBlockDrawerId === block.id}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>

      {/* Command detail drawer */}
      {openDrawerCmd && (
        <CommandDrawer
          cmd={openDrawerCmd}
          allCommands={COMMANDS}
          onClose={() => setOpenDrawerId(null)}
          onCopy={handleCopyFromDrawer}
          onSend={handleSendFromDrawer}
          isCopied={copiedId === openDrawerCmd.id}
          isSent={sentId === openDrawerCmd.id}
          onNavigate={(id) => setOpenDrawerId(id)}
        />
      )}

      {/* Diagnostic block drawer */}
      {openBlockDrawer && (
        <DiagnosticBlockDrawer
          block={openBlockDrawer}
          allCommands={COMMANDS}
          onClose={() => setOpenBlockDrawerId(null)}
          onCopyLight={blockCopyLight}
          onCopyHeavy={blockCopyHeavy}
          onSendLight={blockSendLight}
          onSendHeavy={blockSendHeavy}
          copiedBlockId={copiedBlockId}
          sentBlockId={sentBlockId}
        />
      )}

      {/* Hard-confirm modal (guard: hard, or guard: confirm triggered from drawer) */}
      {hardConfirmCmd && (
        <ConfirmModal
          cmd={hardConfirmCmd}
          onCancel={() => {
            setHardConfirmCmd(null);
            setHardConfirmText("");
          }}
          onConfirm={handleHardConfirm}
          hardConfirmText={hardConfirmText}
          setHardConfirmText={setHardConfirmText}
          action={hardConfirmAction}
        />
      )}
    </div>
  );
}
