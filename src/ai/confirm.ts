import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContaminationFinding } from '../types.js';

/**
 * Cascade step 5 — AI intent confirmation. OPT-IN ONLY (--ai flag +
 * ANTHROPIC_API_KEY): the deterministic scan never calls an LLM.
 *
 * Findings in the uncertain band get a yes/no "same business intent?"
 * judgment from a small Claude model. Confirmed -> confidence boosted and
 * tagged; refuted -> dropped. Any API failure leaves the finding untouched
 * (observe, don't block). Raw fetch, no SDK — this package ships with zero
 * runtime dependencies beyond the TypeScript parser.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_CANDIDATES = 8;
const MAX_SNIPPET_LINES = 60;
const TIMEOUT_MS = 20_000;

export interface ConfirmResult {
  findings: ContaminationFinding[];
  confirmed: number;
  refuted: number;
  skipped: number;
}

export interface ConfirmOptions {
  apiKey?: string;
  model?: string;
  /** Test seam — defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

export async function confirmFindings(
  findings: ContaminationFinding[],
  root: string,
  opts: ConfirmOptions = {},
): Promise<ConfirmResult> {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return { findings, confirmed: 0, refuted: 0, skipped: findings.length };

  // EUTHYNOS_AI_MODEL is the current name; the pre-rename variable is still
  // honoured so an existing configuration does not silently change model.
  const model =
    opts.model ?? process.env['EUTHYNOS_AI_MODEL'] ?? process.env['CONTEXTHUB_AI_MODEL'] ?? DEFAULT_MODEL;
  const fetchFn = opts.fetchFn ?? fetch;

  // The uncertain band (unconfirmed 60-79 + firm-but-checkable 80-95).
  // 96+ clones are structural facts — no model call needed.
  const inBand = findings.filter((f) => f.confidence >= 60 && f.confidence <= 95 && !f.aiVerdict);
  const toCheck = inBand.slice(0, MAX_CANDIDATES);

  const kept: ContaminationFinding[] = [];
  let confirmed = 0, refuted = 0, skipped = findings.length - toCheck.length;

  const checking = new Set(toCheck);
  for (const f of findings) {
    if (!checking.has(f)) {
      kept.push(f);
      continue;
    }
    const verdict = await judge(f, root, apiKey, model, fetchFn);
    if (verdict === 'same') {
      confirmed++;
      kept.push({ ...f, confidence: Math.min(96, f.confidence + 10), aiVerdict: 'confirmed' });
    } else if (verdict === 'different') {
      refuted++; // dropped
    } else {
      skipped++;
      kept.push(f); // API failure: leave the rule-engine verdict standing
    }
  }

  kept.sort((x, y) => y.confidence - x.confidence);
  return { findings: kept, confirmed, refuted, skipped };
}

async function judge(
  f: ContaminationFinding,
  root: string,
  apiKey: string,
  model: string,
  fetchFn: typeof fetch,
): Promise<'same' | 'different' | 'unknown'> {
  const a = snippet(root, f.a.file, f.a.line, f.a.endLine);
  const b = snippet(root, f.b.file, f.b.line, f.b.endLine);
  if (!a || !b) return 'unknown';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system:
          'You judge whether two code functions implement the same business intent (semantic duplicates that should be consolidated), not merely similar shapes. Generic helpers with different purposes are NOT the same intent.',
        messages: [
          {
            role: 'user',
            content: `Function A — ${f.a.file}:${f.a.line} (${f.a.name}):\n\`\`\`\n${a}\n\`\`\`\n\nFunction B — ${f.b.file}:${f.b.line} (${f.b.name}):\n\`\`\`\n${b}\n\`\`\`\n\nDo these implement the same business intent?`,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                same_intent: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['same_intent', 'reason'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!res.ok) return 'unknown';
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b) => b.type === 'text')?.text;
    if (!text) return 'unknown';
    const parsed = JSON.parse(text) as { same_intent?: boolean };
    if (typeof parsed.same_intent !== 'boolean') return 'unknown';
    return parsed.same_intent ? 'same' : 'different';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

function snippet(root: string, file: string, start: number, end: number): string | null {
  try {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    const from = Math.max(0, start - 1);
    const to = Math.min(lines.length, Math.min(end, start + MAX_SNIPPET_LINES - 1));
    const out = lines.slice(from, to).join('\n');
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}
