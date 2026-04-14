import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

export default function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Courier New", monospace',
      fontSize: 13,
      theme: { background: "#111", foreground: "#d4d4d4", cursor: "#d4d4d4" },
      scrollback: 5000,
      convertEol: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    // Each keystroke → raw bytes to serial port (xterm handles special keys).
    term.onData((data) => {
      invoke("send_serial_raw", { data }).catch(() => {});
    });

    // Raw serial bytes from the backend reader thread.
    const unlistenPromise = listen<string>("serial-data", (event) => {
      term.write(event.payload);
    });

    // Refit on container resize.
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore during unmount */
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unlistenPromise.then((fn) => fn());
      ro.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    />
  );
}
