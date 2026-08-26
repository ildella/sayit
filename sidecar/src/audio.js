// Audio helpers shared by every synthesis engine (kokoro, piper, …).

export const MAX_CHUNK_CHARS = 400;

/** Split text into speakable chunks at sentence boundaries. */
export function chunkText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?;:]+[.!?;:]*\s*/g) || [clean];
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > MAX_CHUNK_CHARS && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** Float32 samples (-1..1) to 16-bit LE PCM mono. */
export function f32ToPcm16(f32) {
  const pcm = Buffer.alloc(f32.length * 2);
  for (let j = 0; j < f32.length; j++) {
    const s = Math.max(-1, Math.min(1, f32[j]));
    pcm.writeInt16LE(Math.round(s * 32767), j * 2);
  }
  return pcm;
}

/** Wrap 16-bit PCM mono in a RIFF/WAVE header. */
export function buildWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
