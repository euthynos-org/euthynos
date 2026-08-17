from ..payment import validate_transaction, capture, refund
from ..auth.helpers import has_token, get_token
from ..orders.validate_payment import validate_payment


def checkout(user, session, amount):
    if not has_token(user, session):
        return False
    token = get_token(user, session)
    result = validate_transaction(amount, 'USD', {'limit': 50000, 'kind': 'card'})
    if not result['ok']:
        return False
    legacy = validate_payment(amount, 'USD', {'limit': 50000, 'kind': 'card'})
    if not legacy['ok']:
        return False
    ok = capture(token, amount)
    if not ok:
        refund(token)
    return ok
