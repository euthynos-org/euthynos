# Planted cross-module clone of payment/validator.validate_transaction —
# renamed identifiers/literals only. Should trip the contamination cascade.
from ..payment.engine import compute_fee

ALLOWED = ['USD', 'GBP', 'JPY']
DANGER = 75


def validate_payment(total, code, channel):
    if total <= 0:
        raise ValueError('total must be positive')
    if code not in ALLOWED:
        raise ValueError('unsupported code')
    if total > channel['limit']:
        raise ValueError('exceeds channel limit')
    charge = compute_fee(total)
    danger = assess_danger(total, channel)
    if danger > DANGER:
        return {'ok': False, 'reason': 'risk', 'fee': charge}
    return {'ok': True, 'reason': None, 'fee': charge}


def assess_danger(total, channel):
    base = 60 if total > 10000 else 20
    if channel['kind'] == 'card':
        base += 10
    return base
