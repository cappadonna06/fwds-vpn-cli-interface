// Types shared with the Rust `list_sd_targets` / `select_firmware_image` /
// `poll_sd_flash` commands (see src-tauri/src/lib.rs, "SD card flashing").

export interface SdTarget {
  /** macOS whole-disk id ("disk6") or Windows disk number ("6"). */
  id: string;
  name: string;
  size_bytes: number;
  size_label: string;
  bus: string;
  removable: boolean;
}

export interface FirmwareInfo {
  path: string;
  file_name: string;
  size_bytes: number;
  size_label: string;
  compressed: boolean;
}

export interface SdFlashPoll {
  /** idle | preparing | writing | flushing | verifying | ejecting | done | failed | cancelled */
  phase: string;
  detail: string;
  /** 0-100, or -1 when indeterminate. */
  percent: number;
  bytes_done: number;
  total_bytes: number;
  rate_bps: number;
  lines: string[];
}
