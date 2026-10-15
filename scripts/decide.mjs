// Pure decision function: no I/O. now / lastAlert are epoch milliseconds.
const SELF = '"benjis-ci"';
const HOSTED = '"ubuntu-latest"';
const SIX_HOURS = 6 * 3600 * 1000;
export const DEFAULT_STATE = { misses: 0, healthy: 0, flipped: false, lastAlert: null };

export function countOnline(runners) {
  return (runners || []).filter(
    (r) => r && r.status === 'online' && (r.labels || []).some((l) => l && l.name === 'benjis-ci'),
  ).length;
}

export function normalizeState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ...DEFAULT_STATE };
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    misses: n(s.misses),
    healthy: n(s.healthy),
    flipped: s.flipped === true,
    lastAlert: Number.isFinite(s.lastAlert) ? s.lastAlert : null,
  };
}

export function decide({ state, online, currentVar, now }) {
  const s = normalizeState(state);
  const actions = [];
  if (online >= 1) {
    s.healthy += 1;
    s.misses = 0;
  } else {
    s.misses += 1;
    s.healthy = 0;
  }
  let slacked = false;
  const slack = (kind) => {
    actions.push({ type: 'slack', kind });
    s.lastAlert = now;
    slacked = true;
  };

  if (s.misses >= 2 && currentVar === SELF) {
    actions.push({ type: 'set_var', value: HOSTED });
    slack('flip');
    actions.push({ type: 'requeue' });
    s.flipped = true;
  } else if (s.flipped && s.healthy >= 3) {
    if (currentVar === HOSTED) {
      actions.push({ type: 'set_var', value: SELF });
      slack('flip');
    }
    s.flipped = false;
  }

  if (s.misses >= 2 && !slacked && (s.lastAlert === null || now - s.lastAlert >= SIX_HOURS)) {
    slack('unhealthy');
  }
  if (s.healthy > 0 && online >= 1) s.lastAlert = null;
  return { state: s, actions };
}
