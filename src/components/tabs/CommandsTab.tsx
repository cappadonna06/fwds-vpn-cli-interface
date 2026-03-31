import { useState, useEffect, useRef, useCallback, ReactNode } from "react";
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
  onCopy: (cmd: ControllerCommand) => void;
  onOpenDrawer: (id: string) => void;
  isCopied: boolean;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  openDrawerId: string | null;
  searchQuery?: string;
}

function CommandRow({
  cmd,
  onCopy,
  onOpenDrawer,
  isCopied,
  isFavorite,
  onToggleFavorite,
  openDrawerId,
  searchQuery = "",
}: CommandRowProps) {
  const isDrawerOpen = openDrawerId === cmd.id;
  const isDestructive = !!cmd.destructive;

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
      </div>

      <div className="cmd-row-actions">
        <button
          className={`cmd-copy-btn ${isCopied ? "cmd-copy-btn-copied" : ""}`}
          onClick={() => onCopy(cmd)}
          title="Copy command to clipboard"
        >
          {isCopied ? "✓ Copied" : "Copy"}
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
  commands: ControllerCommand[];
  onCopyLight: (block: DiagnosticBlock) => void;
  onCopyHeavy: (block: DiagnosticBlock) => void;
  copiedBlockId: string | null;
}

function DiagnosticBlockRow({
  block,
  commands,
  onCopyLight,
  onCopyHeavy,
  copiedBlockId,
}: DiagnosticBlockRowProps) {
  const lightCopied = copiedBlockId === `${block.id}-light`;
  const heavyCopied = copiedBlockId === `${block.id}-heavy`;
  const singleCopied = copiedBlockId === `${block.id}-single`;

  const hasDistinctTiers =
    block.light_command_ids.length > 0 &&
    block.heavy_command_ids.length > 0 &&
    JSON.stringify(block.light_command_ids) !== JSON.stringify(block.heavy_command_ids);

  const lightTooltip = block.light_command_ids
    .map((id) => {
      const c = commands.find((x) => x.id === id);
      return c ? c.command : id;
    })
    .join("\n");

  const heavyTooltip = block.heavy_command_ids
    .map((id) => {
      const c = commands.find((x) => x.id === id);
      return c ? c.command : id;
    })
    .join("\n");

  return (
    <div className="diag-block-row">
      <div className="diag-block-icon">{block.icon}</div>
      <div className="diag-block-content">
        <div className="diag-block-header">
          <span className="diag-block-label">{block.label}</span>
          <div className="diag-block-actions">
            {hasDistinctTiers ? (
              <>
                <button
                  className={`diag-block-btn ${lightCopied ? "diag-block-btn-copied" : ""}`}
                  onClick={() => onCopyLight(block)}
                  title={lightTooltip}
                >
                  {lightCopied ? "✓" : "Light"}
                </button>
                <button
                  className={`diag-block-btn diag-block-btn-heavy ${heavyCopied ? "diag-block-btn-copied" : ""}`}
                  onClick={() => onCopyHeavy(block)}
                  title={heavyTooltip}
                >
                  {heavyCopied ? "✓" : "Heavy"}
                </button>
              </>
            ) : (
              <button
                className={`diag-block-btn ${singleCopied ? "diag-block-btn-copied" : ""}`}
                onClick={() => onCopyHeavy(block)}
                title={heavyTooltip}
              >
                {singleCopied ? "✓" : "Copy"}
              </button>
            )}
          </div>
        </div>
        <div className="diag-block-desc">{block.description}</div>
        {block.time_warning && (
          <div className="diag-block-warning">{block.time_warning}</div>
        )}
      </div>
    </div>
  );
}

// ─── CommandDrawer ────────────────────────────────────────────────────────────

interface CommandDrawerProps {
  cmd: ControllerCommand;
  allCommands: ControllerCommand[];
  onClose: () => void;
  onCopy: (cmd: ControllerCommand) => void;
  isCopied: boolean;
  onNavigate: (id: string) => void;
}

function CommandDrawer({
  cmd,
  allCommands,
  onClose,
  onCopy,
  isCopied,
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

// ─── ConfirmModal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  cmd: ControllerCommand;
  onCancel: () => void;
  onConfirm: (text: string) => void;
  hardConfirmText: string;
  setHardConfirmText: (v: string) => void;
}

function ConfirmModal({
  cmd,
  onCancel,
  onConfirm,
  hardConfirmText,
  setHardConfirmText,
}: ConfirmModalProps) {
  const isHard = cmd.guard === "hard";
  const canConfirm = !isHard || hardConfirmText === cmd.command;

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
        <div className="modal-title">
          {isHard ? "Warning — Destructive Action" : "Confirm"}
        </div>
        <div className="modal-body">{cmd.guard_message}</div>
        {isHard && (
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
                if (e.key === "Enter" && canConfirm) onConfirm(cmd.command);
              }}
            />
          </div>
        )}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`btn ${cmd.destructive ? "btn-danger" : "btn-primary"}`}
            disabled={!canConfirm}
            onClick={() => onConfirm(cmd.command)}
          >
            Copy {cmd.command}
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("fwds-favorite-commands");
      return stored ? (JSON.parse(stored) as string[]) : FAVORITE_COMMAND_IDS;
    } catch {
      return FAVORITE_COMMAND_IDS;
    }
  });
  const [recentlyUsed, setRecentlyUsed] = useState<string[]>([]);
  const [confirmCommand, setConfirmCommand] = useState<ControllerCommand | null>(null);
  const [hardConfirmText, setHardConfirmText] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);

  // Register external recent-command adder
  useEffect(() => {
    _addRecentExternal = (id: string) => {
      setRecentlyUsed((prev) => {
        const filtered = prev.filter((x) => x !== id);
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
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  function doCopy(text: string, id: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
  }

  function handleCopy(cmd: ControllerCommand) {
    if (cmd.guard === "hard" || cmd.guard === "confirm") {
      setHardConfirmText("");
      setConfirmCommand(cmd);
      return;
    }
    doCopy(cmd.command, cmd.id);
  }

  function handleConfirm(_text: string) {
    if (confirmCommand) {
      doCopy(confirmCommand.command, confirmCommand.id);
      setConfirmCommand(null);
      setHardConfirmText("");
    }
  }

  function handleOpenDrawer(id: string) {
    setOpenDrawerId((prev) => (prev === id ? null : id));
  }

  function handleBlockCopy(block: DiagnosticBlock, tier: "light" | "heavy" | "single") {
    const ids = tier === "light" ? block.light_command_ids : block.heavy_command_ids;
    const text = ids
      .map((id) => {
        const c = COMMANDS.find((x) => x.id === id);
        return c ? c.command : id;
      })
      .join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    const key = tier === "single" ? `${block.id}-single` : `${block.id}-${tier}`;
    setCopiedBlockId(key);
    setTimeout(
      () => setCopiedBlockId((prev) => (prev === key ? null : prev)),
      1500
    );
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
          (c.tags ?? []).some((t) => t.toLowerCase().includes(q))
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
    .map((id) => COMMANDS.find((c) => c.id === id))
    .filter((c): c is ControllerCommand => c !== undefined);

  const openDrawerCmd = openDrawerId
    ? COMMANDS.find((c) => c.id === openDrawerId) ?? null
    : null;

  // Group for "all" tab
  const grouped: Partial<Record<CommandCategory, ControllerCommand[]>> = {};
  if (!isSearching && paletteTab === "all") {
    for (const cmd of displayedCommands) {
      grouped[cmd.category] = [...(grouped[cmd.category] ?? []), cmd];
    }
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
                    onCopy={handleCopy}
                    onOpenDrawer={handleOpenDrawer}
                    isCopied={copiedId === cmd.id}
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
                    <div className="palette-group-label">Recently Used</div>
                    {recentCmds.map((cmd) => (
                      <CommandRow
                        key={cmd.id}
                        cmd={cmd}
                        onCopy={handleCopy}
                        onOpenDrawer={handleOpenDrawer}
                        isCopied={copiedId === cmd.id}
                        isFavorite={favorites.includes(cmd.id)}
                        onToggleFavorite={handleToggleFavorite}
                        openDrawerId={openDrawerId}
                      />
                    ))}
                  </div>
                )}
                {displayedCommands.length === 0 ? (
                  <div className="palette-empty">No favorites yet. Click ☆ on any command.</div>
                ) : (
                  displayedCommands.map((cmd) => (
                    <CommandRow
                      key={cmd.id}
                      cmd={cmd}
                      onCopy={handleCopy}
                      onOpenDrawer={handleOpenDrawer}
                      isCopied={copiedId === cmd.id}
                      isFavorite={favorites.includes(cmd.id)}
                      onToggleFavorite={handleToggleFavorite}
                      openDrawerId={openDrawerId}
                    />
                  ))
                )}
              </>
            ) : paletteTab === "common" ? (
              displayedCommands.length === 0 ? (
                <div className="palette-empty">No commands.</div>
              ) : (
                displayedCommands.map((cmd) => (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    onCopy={handleCopy}
                    onOpenDrawer={handleOpenDrawer}
                    isCopied={copiedId === cmd.id}
                    isFavorite={favorites.includes(cmd.id)}
                    onToggleFavorite={handleToggleFavorite}
                    openDrawerId={openDrawerId}
                  />
                ))
              )
            ) : (
              // "all" tab — grouped
              (["config", "diagnostic", "info", "system"] as CommandCategory[]).map((cat) =>
                grouped[cat]?.length ? (
                  <div key={cat} className="palette-group">
                    <div className="palette-group-label">{categoryLabel(cat)}</div>
                    {grouped[cat]!.map((cmd) => (
                      <CommandRow
                        key={cmd.id}
                        cmd={cmd}
                        onCopy={handleCopy}
                        onOpenDrawer={handleOpenDrawer}
                        isCopied={copiedId === cmd.id}
                        isFavorite={favorites.includes(cmd.id)}
                        onToggleFavorite={handleToggleFavorite}
                        openDrawerId={openDrawerId}
                      />
                    ))}
                  </div>
                ) : null
              )
            )}
          </div>
        </div>

        {/* Right — diagnostic blocks */}
        <div className="commands-blocks">
          <div className="commands-blocks-heading">Diagnostic Blocks</div>
          {DIAGNOSTIC_BLOCKS.map((block) => (
            <DiagnosticBlockRow
              key={block.id}
              block={block}
              commands={COMMANDS}
              onCopyLight={(b) => handleBlockCopy(b, "light")}
              onCopyHeavy={(b) => {
                const hasDistinct =
                  b.light_command_ids.length > 0 &&
                  b.heavy_command_ids.length > 0 &&
                  JSON.stringify(b.light_command_ids) !== JSON.stringify(b.heavy_command_ids);
                handleBlockCopy(b, hasDistinct ? "heavy" : "single");
              }}
              copiedBlockId={copiedBlockId}
            />
          ))}
        </div>
      </div>

      {/* Command detail drawer */}
      {openDrawerCmd && (
        <CommandDrawer
          cmd={openDrawerCmd}
          allCommands={COMMANDS}
          onClose={() => setOpenDrawerId(null)}
          onCopy={handleCopy}
          isCopied={copiedId === openDrawerCmd.id}
          onNavigate={(id) => setOpenDrawerId(id)}
        />
      )}

      {/* Confirm modal */}
      {confirmCommand && (
        <ConfirmModal
          cmd={confirmCommand}
          onCancel={() => {
            setConfirmCommand(null);
            setHardConfirmText("");
          }}
          onConfirm={handleConfirm}
          hardConfirmText={hardConfirmText}
          setHardConfirmText={setHardConfirmText}
        />
      )}
    </div>
  );
}
