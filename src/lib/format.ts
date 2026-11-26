// Shared number/date formatters for the dashboard.

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${v.toFixed(digits)}%`;
}

export function fmtSignedPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtSignedUsd(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Adaptive precision: 2 decimals for large prices, more for sub-1 assets. */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtDateTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '-';
  const totalMin = Math.round(minutes);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function fmtRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(0)}%`;
}
