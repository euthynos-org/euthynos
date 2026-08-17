import { computeFee } from './engine.js';

interface PaymentMethod {
  limit: number;
  kind: string;
}

interface ValidationResult {
  ok: boolean;
  reason: string | null;
  fee: number;
}

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'INR'];
const RISK_THRESHOLD = 80;

export function validateTransaction(amount: number, currency: string, method: PaymentMethod): ValidationResult {
  if (amount <= 0) {
    throw new Error('amount must be positive');
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error('unsupported currency');
  }
  if (amount > method.limit) {
    throw new Error('exceeds method limit');
  }
  const fee = computeFee(amount);
  const riskScore = assessRisk(amount, method);
  if (riskScore > RISK_THRESHOLD) {
    return { ok: false, reason: 'risk', fee: fee };
  }
  return { ok: true, reason: null, fee: fee };
}

function assessRisk(amount: number, method: PaymentMethod): number {
  let base = amount > 10000 ? 60 : 20;
  if (method.kind === 'card') {
    base += 10;
  }
  return base;
}
