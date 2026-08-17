FEE_TABLE = {'standard': 0.029, 'premium': 0.019}
MIN_FEE = 0.3
_ledger = []


def compute_fee(amount):
    rate = FEE_TABLE.get('standard', 0.029)
    raw = amount * rate
    return MIN_FEE if raw < MIN_FEE else round(raw, 2)


def capture(txn_id, amount):
    fee = compute_fee(amount)
    net = amount - fee
    if net <= 0:
        return False
    _ledger.append({'id': txn_id, 'amount': net, 'state': 'captured'})
    _reconcile()
    return True


def refund(txn_id):
    entry = _find(txn_id)
    if entry is None or entry['state'] != 'captured':
        return False
    entry['state'] = 'refunded'
    _reconcile()
    return True


def _find(txn_id):
    for e in _ledger:
        if e['id'] == txn_id:
            return e
    return None


def _reconcile():
    captured = 0
    refunded = 0
    for e in _ledger:
        if e['state'] == 'captured':
            captured += e['amount']
        elif e['state'] == 'refunded':
            refunded += e['amount']
    _audit(captured, refunded)


def _audit(captured, refunded):
    if refunded > captured:
        raise ValueError('ledger inconsistency: refunds exceed captures')
