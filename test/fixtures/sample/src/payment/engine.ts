const FEE_TABLE: Record<string, number> = {
  standard: 0.029,
  premium: 0.019,
  enterprise: 0.009,
};

const MIN_FEE = 0.3;
const ledger: Array<{ id: string; amount: number; state: string }> = [];

export function computeFee(amount: number): number {
  const rate = FEE_TABLE['standard'] ?? 0.029;
  const raw = amount * rate;
  return raw < MIN_FEE ? MIN_FEE : Math.round(raw * 100) / 100;
}

export function capture(id: string, amount: number): boolean {
  const fee = computeFee(amount);
  const net = amount - fee;
  if (net <= 0) {
    return false;
  }
  ledger.push({ id, amount: net, state: 'captured' });
  reconcile();
  return true;
}

export function refund(id: string): boolean {
  const entry = findEntry(id);
  if (!entry || entry.state !== 'captured') {
    return false;
  }
  entry.state = 'refunded';
  reconcile();
  return true;
}

function findEntry(id: string): { id: string; amount: number; state: string } | undefined {
  for (const e of ledger) {
    if (e.id === id) {
      return e;
    }
  }
  return undefined;
}

function reconcile(): void {
  let captured = 0;
  let refunded = 0;
  for (const e of ledger) {
    if (e.state === 'captured') {
      captured += e.amount;
    } else if (e.state === 'refunded') {
      refunded += e.amount;
    }
  }
  audit(captured, refunded);
}

function audit(captured: number, refunded: number): void {
  if (refunded > captured) {
    throw new Error('ledger inconsistency: refunds exceed captures');
  }
}

export function summarizeLedger(): string {
  const counts: Record<string, number> = {};
  for (const e of ledger) {
    counts[e.state] = (counts[e.state] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const state of Object.keys(counts).sort()) {
    parts.push(state + '=' + counts[state]);
  }
  return parts.join(', ');
}
