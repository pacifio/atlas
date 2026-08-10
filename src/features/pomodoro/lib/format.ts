const padZ = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");

export function fmtHM(mins: number): string {
  const m = Math.max(0, Math.floor(mins));
  return `${padZ(Math.floor(m / 60))}:${padZ(m % 60)}`;
}

export function fmtDur(mins: number): string {
  const m = Math.max(0, Math.floor(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  if (h) return `${h}h`;
  return `${r}m`;
}

export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${padZ(Math.floor(s / 60))}:${padZ(s % 60)}`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${padZ(d.getMonth() + 1)}-${padZ(d.getDate())}`;
}

export function nowMinOfDay(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
