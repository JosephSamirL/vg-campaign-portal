/**
 * A short, stable reference for a failure message: FNV-1a (32-bit, hex) of the text. The raw
 * PostgREST / Postgres message goes to the server log next to this digest; the browser sees
 * only the digest, so a brand user can quote it to support without ever seeing schema names
 * or error codes. Deterministic, dependency-free, runs in any runtime.
 */
export function errorDigest(message: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
