/**
 * sunolift / shared / util.js
 * ---------------------------------------------------------------
 * The prelude. Everything here is visible to the other shared modules in BOTH
 * execution models: as real ESM imports in Node/desktop, and as a flat closure
 * in the generated extension bundle (tools/bundle-shared.js wraps every other
 * module in its own function scope, so a private helper with the same name in
 * two files can never collide - but it also cannot be shared). Keeping the
 * tiny numeric helpers in one place is what makes both work.
 */

export const round = (v, d = 4) => {
  const p = 10 ** d;
  return Math.round((Number(v) || 0) * p) / p;
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);

/** Parse to a finite number or null. Empty strings and NaN are meaningless in metadata. */
export const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : null;
};

/** m:ss(.d) - the human-facing clock used by every sidecar and the HUD. */
export const fmtClock = (sec, decimals = 1) => {
  if (sec == null || !isFinite(sec)) return 'n/a';
  const sign = sec < 0 ? '-' : '';
  const s = Math.abs(sec);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${sign}${m}:${r.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`;
};

/** Deterministic small hash used for capture ids when crypto is unavailable. */
export const shortHash = (str) => {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).slice(0, 8);
};
