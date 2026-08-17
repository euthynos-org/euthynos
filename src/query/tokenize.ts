/**
 * IDENTIFIER AND QUERY TOKENIZATION — the shared alphabet of the query shaper.
 *
 * Everything downstream (vocabulary, BM25, intent rules, entity extraction)
 * compares tokens, so they must be produced ONE way. A second, slightly
 * different splitter somewhere else is how a search silently stops matching
 * the thing it used to match.
 *
 * Deterministic and allocation-cheap: this runs over every symbol in a
 * repository at index time.
 */

/**
 * Split a chunk of identifier text on case boundaries.
 *
 *   parseHTTPRequest -> parse, HTTP, Request     (acronym run kept whole)
 *   HTTPServer       -> HTTP, Server
 *   utf8Decode       -> utf8, Decode             (digits stay with their word)
 *
 * The acronym alternative comes first and refuses to eat the capital that
 * starts the next word, which is the case a naive `[A-Z][a-z]*` splitter gets
 * wrong — it would yield `HTTPS`/`erver` on `HTTPServer`.
 */
const WORD = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

/**
 * Tokens of an identifier, lowercased, in source order, duplicates kept
 * (term frequency is real signal — `authAuthHandler` really is about auth).
 *
 *   splitIdentifier('jwt_verify-Token') -> ['jwt', 'verify', 'token']
 */
export function splitIdentifier(name: string): string[] {
  const out: string[] = [];
  // Separators first (snake, kebab, dots, slashes, spaces), then case splits.
  for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    const matches = chunk.match(WORD);
    if (matches === null) continue;
    for (const m of matches) out.push(m.toLowerCase());
  }
  return out;
}

/**
 * Words that carry no repository meaning. Deliberately small: an aggressive
 * stopword list deletes real symbol names (`get`, `set`, `map`, `type` and
 * `error` are all things people genuinely search for), so only words that
 * are pure query scaffolding are removed.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'of', 'on', 'or', 'our',
  'out', 'please', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'up', 'us', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

/** Lowercased, punctuation-normalized query text — the input every rule sees. */
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Content tokens of a natural-language query: identifier-split so
 * `authMiddleware` in a sentence matches the same tokens as the symbol, with
 * scaffolding words dropped.
 */
export function queryTokens(q: string): string[] {
  return splitIdentifier(q).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/**
 * The acronym a multi-word name would be abbreviated to, or null when there
 * isn't a meaningful one.
 *
 *   ['json','web','token'] -> 'jwt'
 *   ['handler']            -> null   (one word is not an acronym)
 *
 * Single-character tokens still contribute their letter, so `a`/`b` generics
 * do not silently vanish from the initials.
 */
export function acronymOf(tokens: readonly string[]): string | null {
  if (tokens.length < 2) return null;
  let acr = '';
  for (const t of tokens) {
    const first = t[0];
    if (first === undefined) continue;
    acr += first;
  }
  return acr.length >= 2 ? acr : null;
}
