import { version } from '../../../package.json';

// Bounded, local-only history. Never record SDP, ICE addresses, room names,
// passwords, chat messages or audio. Error names are enough to classify failures.
const key = 'mikcort:connection-diagnostics';
type Details = Record<string, unknown>;
const entries: Array<{ at: string; event: string; details: Details }> = [];
try {
  const saved = JSON.parse(localStorage.getItem(key) || '[]');
  if (Array.isArray(saved)) entries.push(...saved.slice(-1000));
} catch { /* Storage may be unavailable. In-memory diagnostics still work. */ }
const aliases = new Map<string, string>();
const run = crypto.randomUUID().slice(0, 8);

export function peerDiagnosticId(userId: string) {
  if (!aliases.has(userId)) aliases.set(userId, `${run}:peer-${aliases.size + 1}`);
  return aliases.get(userId)!;
}

export function recordConnectionEvent(event: string, details: Details = {}) {
  entries.push({ at: new Date().toISOString(), event, details });
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
  try { localStorage.setItem(key, JSON.stringify(entries)); } catch { /* Best effort. */ }
}

export function connectionErrorDetails(cause: unknown) {
  return {
    name: cause instanceof Error ? cause.name : 'UnknownError',
    detail: typeof RTCError !== 'undefined' && cause instanceof RTCError ? cause.errorDetail : undefined,
  };
}

export function connectionDiagnosticsReport() {
  return JSON.stringify({ version, exportedAt: new Date().toISOString(), run, entries }, null, 2);
}
