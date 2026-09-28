// Best-effort protection within a warm Vercel instance. Restarts and other instances
// have their own memory; strict deduplication requires shared persistent storage.
export function createSmsGuard({ now = Date.now, ttlMs = 60 * 60 * 1000, maxEntries = 10000 } = {}) {
  const recent = new Map();
  return {
    claim(key) {
      const time = now();
      for (const [entry, expiresAt] of recent) {
        if (expiresAt <= time) recent.delete(entry);
      }
      if (recent.has(key)) return false;
      if (recent.size >= maxEntries) throw new Error('SMS duplicate guard capacity reached');
      // Claim BEFORE calling the SMS API, including while its result is unknown.
      recent.set(key, time + ttlMs);
      return true;
    }
  };
}
