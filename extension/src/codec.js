// Pakiranje snapshota za chrome.storage.sync: JSON → gzip → base64 → dijelovi.
// Kvote storage.sync (developer.chrome.com, 30.10.2026): 8192 B po stavci (ključ + JSON vrijednost), 102400 B ukupno.

export const CHUNK_CHARS = 7900; // base64 znakova po dijelu: + navodnici + ključ < 8192
export const MAX_CHUNKS_PER_DEVICE = 5; // 2 uređaja × 5 × ~7,9 KB ≈ 80 KB < 100 KB kvote

function bytesToBase64(bytes) {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** SHA-256 heks (prvih 16 znakova je dovoljno za prepoznavanje stanja i provjeru cjelovitosti). */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * @returns {Promise<{chunks: string[], h: string}>} h = hash sažetog sadržaja (provjera da su stigli svi dijelovi)
 */
export async function encodeSnapshot(snapshot) {
  const json = new TextEncoder().encode(JSON.stringify(snapshot));
  const gz = await pipeThrough(json, new CompressionStream('gzip'));
  const b64 = bytesToBase64(gz);
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
  return { chunks, h: await sha256Hex(b64) };
}

/**
 * Sastavi dijelove natrag. Vraća null ako dijelovi nisu cjeloviti ili ne odgovaraju hashu
 * (Google sync može isporučiti stavke u različitim trenucima — tada se čeka idući pokušaj).
 */
export async function decodeSnapshot(chunks, expectedHash) {
  if (!Array.isArray(chunks) || chunks.some((c) => typeof c !== 'string')) return null;
  const b64 = chunks.join('');
  if ((await sha256Hex(b64)) !== expectedHash) return null;
  try {
    const json = await pipeThrough(base64ToBytes(b64), new DecompressionStream('gzip'));
    return JSON.parse(new TextDecoder().decode(json));
  } catch {
    return null;
  }
}
