/** Display formatting. Monetary values arrive from the API as decimal strings and are never summed here. */

let activeTimeZone: string | undefined;

export function setDisplayTimeZone(tz: string | undefined) {
  activeTimeZone = tz && tz !== "UTC" ? tz : tz === "UTC" ? "UTC" : undefined;
}

export function formatMoney(amount: string | number | null | undefined, currency = "USD", opts: { compact?: boolean } = {}): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = typeof amount === "number" ? amount : Number(amount);
  if (Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? 1 : 2,
    minimumFractionDigits: opts.compact ? 0 : 2,
  }).format(value);
}

export interface MoneyAmount {
  currency: string;
  amount: string;
}

export function formatMoneyList(list: MoneyAmount[] | undefined, opts: { compact?: boolean; empty?: string } = {}): string {
  if (!list || list.length === 0) return opts.empty ?? formatMoney(0, "USD", opts);
  return list.map((m) => formatMoney(m.amount, m.currency, opts)).join(" · ");
}

/** Seconds → "3h 05m" (or "45m"). */
export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Seconds → "01:02:03" for running timers. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

export function formatHours(hours: string | number | null | undefined, digits = 1): string {
  if (hours === null || hours === undefined || hours === "") return "—";
  const value = Number(hours);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })}h`;
}

export function hoursFromSeconds(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

function parse(value: string | Date): Date {
  if (value instanceof Date) return value;
  // Plain dates (YYYY-MM-DD) are calendar dates, not instants: keep them in local time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

export function formatDate(value: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  if (!value) return "—";
  const isPlainDate = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: isPlainDate ? undefined : activeTimeZone }).format(parse(value));
}

export function formatDateShort(value: string | Date | null | undefined): string {
  return formatDate(value, { month: "short", day: "numeric" });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: activeTimeZone,
  }).format(parse(value));
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: activeTimeZone }).format(parse(value));
}

export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = parse(value);
  const diff = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(date);
}

/** Days from today to a YYYY-MM-DD date (negative = past). */
export function daysUntil(value: string | null | undefined, today: Date = new Date()): number | null {
  if (!value) return null;
  const target = parse(value);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - base.getTime()) / 86400000);
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function percent(value: string | number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${Number(value).toFixed(digits)}%`;
}

export function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
