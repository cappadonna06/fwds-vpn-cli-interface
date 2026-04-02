export type StatusPillState = "success" | "error" | "neutral";

interface StatusPillProps {
  label: string;
  state: StatusPillState;
}

export default function StatusPill({ label, state }: StatusPillProps) {
  return <span className={`status-pill status-pill-${state}`}>{label}</span>;
}
