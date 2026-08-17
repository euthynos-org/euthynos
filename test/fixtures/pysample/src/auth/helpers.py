_cache = {}


def get_token(user, session):
    return user + ':' + session


def set_token(user, session, token):
    _cache[user + session] = token


def has_token(user, session):
    return bool(_cache.get(user + session))


def clear_token(user, session):
    _cache.pop(user + session, None)


def token_length(token):
    return len(token)


def is_expired(ts, now):
    return now > ts


def short_id(value):
    return value[:8]
