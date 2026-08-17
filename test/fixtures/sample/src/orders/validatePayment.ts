// Planted contamination: a renamed structural clone of payment/validator.ts,
// plus a deep import that bypasses payment's public interface.
import { computeFee } from '../payment/engine.js';

interface PayChannel {
  limit: number;
  kind: string;
}

interface CheckOutcome {
  ok: boolean;
  reason: string | null;
  fee: number;
}

const ALLOWED_CODES = ['USD', 'GBP', 'JPY'];
const DANGER_LIMIT = 75;

export function validatePayment(total: number, code: string, channel: PayChannel): CheckOutcome {
  if (total <= 0) {
    throw new Error('total must be positive');
  }
  if (!ALLOWED_CODES.includes(code)) {
    throw new Error('unsupported code');
  }
  if (total > channel.limit) {
    throw new Error('exceeds channel limit');
  }
  const charge = computeFee(total);
  const danger = assessDanger(total, channel);
  if (danger > DANGER_LIMIT) {
    return { ok: false, reason: 'risk', fee: charge };
  }
  return { ok: true, reason: null, fee: charge };
}

function assessDanger(total: number, channel: PayChannel): number {
  let base = total > 10000 ? 60 : 20;
  if (channel.kind === 'card') {
    base += 10;
  }
  return base;
}

export function processToken(user: string, session: string): string {
  const parts = [user, session, 'v1'];
  const joined = parts.join('|');
  let hash = 7;
  for (const ch of joined) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 100003;
  }
  return joined + '#' + hash.toString(16);
}

// Planted step-4 bait: same concept as payment's summarizeLedger, drifted
// spelling, structurally different body — only the naming heuristic sees it.
export function summariseLedger(entries: Array<{ state: string }>): string {
  const seen = new Map<string, number>();
  entries.forEach((entry) => {
    seen.set(entry.state, (seen.get(entry.state) ?? 0) + 1);
  });
  let out = '';
  for (const [state, n] of [...seen.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    out += (out ? ', ' : '') + state + '=' + n;
  }
  return out;
}
