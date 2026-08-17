from .engine import compute_fee

SUPPORTED = ['USD', 'EUR', 'INR']
RISK_THRESHOLD = 80


def validate_transaction(amount, currency, method):
    if amount <= 0:
        raise ValueError('amount must be positive')
    if currency not in SUPPORTED:
        raise ValueError('unsupported currency')
    if amount > method['limit']:
        raise ValueError('exceeds method limit')
    fee = compute_fee(amount)
    risk = assess_risk(amount, method)
    if risk > RISK_THRESHOLD:
        return {'ok': False, 'reason': 'risk', 'fee': fee}
    return {'ok': True, 'reason': None, 'fee': fee}


def assess_risk(amount, method):
    base = 60 if amount > 10000 else 20
    if method['kind'] == 'card':
        base += 10
    return base
