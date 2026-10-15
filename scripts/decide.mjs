// Pure failover decision. No I/O. See issue #1 "Design (decided)".
const ZERO = () => ({ misses: 0, healthy: 0, flipped: false, last_alert: null });
const SIX_HOURS = 6 * 3600_000;

function parseState(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return ZERO(); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ZERO();
  const cnt = (n) => Number.isInteger(n) && n >= 0;
  if (!cnt(v.misses) || !cnt(v.healthy) || typeof v.flipped !== 'boolean') return ZERO();
  if (v.last_alert !== null && typeof v.last_alert !== 'string') return ZERO();
  return { misses: v.misses, healthy: v.healthy, flipped: v.flipped, last_alert: v.last_alert };
}

export function decide({ state, online, current, now }) {
  const s = parseState(state);
  if (online >= 1) { s.healthy += 1; s.misses = 0; } else { s.misses += 1; s.healthy = 0; }

  let decision = 'none';
  let writeVar = null;

  if (s.flipped && current !== 'ubuntu-latest') s.flipped = false;

  if (s.misses >= 2 && current === 'benjis-ci') {
    decision = 'flip_hosted';
    writeVar = '"ubuntu-latest"';
    s.flipped = true;
  } else if (s.healthy >= 3 && s.flipped && current === 'ubuntu-latest') {
    decision = 'flip_back';
    writeVar = '"benjis-ci"';
    s.flipped = false;
  }

  let alert = decision === 'flip_hosted';
  if (!alert && s.misses >= 2) {
    const last = s.last_alert ? Date.parse(s.last_alert) : NaN;
    alert = Number.isNaN(last) || now.getTime() - last >= SIX_HOURS;
  }
  if (alert) s.last_alert = now.toISOString();

  return { decision, state: s, writeVar, alert };
}
