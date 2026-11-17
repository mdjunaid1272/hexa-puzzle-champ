// Seeded PRNG (mulberry32) — deterministic, reproducible via ?seed= URL param.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reads the optional ?seed= URL parameter. `search` can be passed in (tests,
 * non-browser use); by default it comes from the page URL, and outside a
 * browser there simply is none, so a random seed is used. */
export function resolveSeed(search?: string): number {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const params = new URLSearchParams(query);
  const seedParam = params.get('seed');
  if (seedParam !== null) {
    const parsed = Number(seedParam);
    if (!Number.isNaN(parsed)) return parsed >>> 0;
  }
  return (Math.random() * 0xffffffff) >>> 0;
}
