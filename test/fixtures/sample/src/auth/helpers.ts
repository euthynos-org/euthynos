export function getToken(user: string, session: string): string {
  return user + ':' + session;
}

export function setToken(user: string, session: string, token: string): void {
  cache[user + session] = token;
}

export function hasToken(user: string, session: string): boolean {
  return Boolean(cache[user + session]);
}

export function clearToken(user: string, session: string): void {
  delete cache[user + session];
}

export function tokenLength(token: string): number {
  return token.length;
}

export function isExpired(ts: number, now: number): boolean {
  return now > ts;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function handleToken(user: string, session: string): string {
  const base = user.trim().toLowerCase();
  const suffix = session.slice(0, 12);
  let out = '';
  for (let i = 0; i < base.length; i++) {
    out += base[i];
    if (i % 4 === 3) {
      out += '-';
    }
  }
  return out + '::' + suffix;
}

const cache: Record<string, string> = {};
