// ============================================================
// format.js — utilidades de formato compartidas
// ============================================================

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

/** "hace 3 días", "ayer"… a partir de un instante (segundos o ISO). */
export function relativeTime(when) {
  const seconds = typeof when === "number" ? when : Date.parse(when) / 1000;
  const diff = seconds - Date.now() / 1000;
  const steps = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return "justo ahora";
}
