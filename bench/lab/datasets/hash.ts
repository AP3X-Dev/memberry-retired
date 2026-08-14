import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type HashMode = 'bytes' | 'text-lf';

export function normalizeForHash(content: Buffer, mode: HashMode): Buffer {
  if (mode === 'bytes') return content;
  const text = content.toString('utf8').replace(/\r\n?/g, '\n');
  return Buffer.from(text, 'utf8');
}

export function sha256(content: Buffer, mode: HashMode = 'bytes'): string {
  return createHash('sha256').update(normalizeForHash(content, mode)).digest('hex');
}

export async function sha256File(path: string, mode: HashMode = 'bytes'): Promise<{ sha256: string; sizeBytes: number }> {
  const content = await readFile(path);
  return { sha256: sha256(content, mode), sizeBytes: normalizeForHash(content, mode).byteLength };
}
