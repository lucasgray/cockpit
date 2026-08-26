import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_MEDIA_TYPES, type ImageMediaType, type TranscriptImage } from '../src/agent/protocol';

/**
 * Where a pasted screenshot lives once a prompt has carried it.
 *
 * Transcripts are replayed from the event stream, and an event is a row in
 * SQLite — so a megabyte of base64 per screenshot would be read back in full,
 * over IPC, every time a worktree was opened. The bytes go to a file beside the
 * database instead and the event keeps only its name, which the renderer draws
 * through the `cockpit-image` scheme (see main.ts).
 *
 * One directory per worktree, keyed by a hash of its path: a worktree that goes
 * away can then take its screenshots with it in a single call, the way it already
 * takes its transcript and its port.
 */

/** Set once at startup with Electron's userData path, like the store beside it. */
let root = '';

export function openImageStore(dir: string) {
  root = path.join(dir, 'images');
}

/** A stable directory name for a worktree — its path is not usable as one. */
function bucket(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 16);
}

const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/**
 * Write this turn's screenshots and describe them the way a transcript needs to.
 *
 * A failure here costs a thumbnail in the replayed conversation, nothing more —
 * the bytes Claude reads are the ones already in the prompt, not these — so it is
 * reported and stepped over rather than allowed to fail the turn.
 */
export async function saveImages(
  cwd: string,
  images: { mediaType: string; data: string }[],
): Promise<TranscriptImage[]> {
  if (!root || !images.length) return [];
  const dir = bucket(cwd);
  const saved: TranscriptImage[] = [];
  try {
    await mkdir(path.join(root, dir), { recursive: true });
  } catch (error) {
    console.error('[cockpit] could not open the image store:', (error as Error).message);
    return saved;
  }

  for (const image of images) {
    if (!isImageType(image.mediaType)) continue;
    const file = `${dir}/${randomUUID()}.${EXTENSIONS[image.mediaType]}`;
    try {
      await writeFile(path.join(root, file), Buffer.from(image.data, 'base64'));
      saved.push({ kind: 'stored', mediaType: image.mediaType, file });
    } catch (error) {
      console.error('[cockpit] could not store a pasted image:', (error as Error).message);
    }
  }
  return saved;
}

/**
 * Serve one stored screenshot by the name its event carries. Anything that
 * resolves outside the store is refused: the renderer can name a file in here and
 * nothing else, which is what makes handing it a URL scheme safe.
 */
export async function readImage(
  file: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType } | null> {
  if (!root || !file) return null;
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const mediaType = MEDIA_TYPES[path.extname(abs).toLowerCase()];
  if (!mediaType) return null;
  try {
    return { bytes: await readFile(abs), mediaType };
  } catch {
    // Deleted with its worktree, or never written — the transcript draws a gap.
    return null;
  }
}

/** Throw away a worktree's screenshots, with its transcript. */
export async function dropImages(cwd: string): Promise<void> {
  if (!root) return;
  await rm(path.join(root, bucket(cwd)), { recursive: true, force: true }).catch((error) => {
    console.error('[cockpit] could not clear stored images:', (error as Error).message);
  });
}
