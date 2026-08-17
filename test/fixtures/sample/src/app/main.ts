import { validateTransaction, capture, refund } from '../payment/index.js';
import { getToken, hasToken } from '../auth/helpers.js';
import { validatePayment } from '../orders/validatePayment.js';

export function checkout(user: string, session: string, amount: number): boolean {
  if (!hasToken(user, session)) {
    return false;
  }
  const token = getToken(user, session);
  const result = validateTransaction(amount, 'USD', { limit: 50000, kind: 'card' });
  if (!result.ok) {
    return false;
  }
  const legacy = validatePayment(amount, 'USD', { limit: 50000, kind: 'card' });
  if (!legacy.ok) {
    return false;
  }
  const ok = capture(token, amount);
  if (!ok) {
    refund(token);
  }
  return ok;
}
