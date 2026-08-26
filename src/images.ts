import { IMAGE_MEDIA_TYPES, type ImageMediaType } from './agent/protocol';

/**
 * Screenshots on their way into a prompt.
 *
 * All of this runs in the renderer, because the clipboard only exists there: a
 * paste hands us a Blob and this turns it into the base64 an image content block
 * takes. Images are normalized on the way in rather than passed through — scaled
 * down to the longest edge the API would have scaled them to anyway, so nothing
 * is lost that the model would have seen, and the IPC payload, the token bill and
 * the file on disk all shrink together.
 */

/**
 * Longest edge worth sending. Anything bigger is resized server-side before the
 * model reads it, so doing it here is free in fidelity — and a retina ⌘⇧4 is
 * routinely 3× over this in each direction, which is 9× the pixels to carry.
 */
const MAX_EDGE = 1568;
/** The API's per-image ceiling. An encode that lands over it is retried smaller. */
const MAX_BYTES = 5 * 1024 * 1024;
/** How many screenshots one prompt can carry. */
export const MAX_IMAGES = 8;

/** A pasted screenshot, prepared and waiting on the composer. */
export type PastedImage = {
  /** Composer-local identity, so the tray can drop this one and not its twin. */
  id: string;
  mediaType: ImageMediaType;
  /** Base64 payload with no `data:` prefix — what the image block carries. */
  data: string;
  /** The same bytes as a `data:` URL, for the thumbnail and the live bubble. */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
};

function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/**
 * The images in a paste or a drop, in order.
 *
 * A screenshot from the clipboard and a file dragged from Finder arrive the same
 * way — as `files` on the transfer — so both paths land here. Types the API won't
 * take are dropped rather than refused loudly: a paste that happens to carry a
 * PDF alongside its image should still bring the image.
 */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) => isImageType(file.type));
}

/** Whether a transfer being dragged over the window holds anything we'd take. */
export function dragHasImages(transfer: DataTransfer | null): boolean {
  // Mid-drag the browser hides the files themselves and offers only their types,
  // so this asks `items` where imageFilesFrom asks `files`.
  return [...(transfer?.items ?? [])].some(
    (item) => item.kind === 'file' && isImageType(item.type),
  );
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('the file could not be read'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Re-encode at `scale`, in the first format that comes back inside the ceiling.
 *
 * PNG first for a screenshot, because that is mostly text and edges and lossy
 * compression is exactly wrong for it; JPEG when the source was already lossy, or
 * when the PNG comes back too big to send. Quality steps down rather than the
 * image going smaller — a legible screenshot is the whole point.
 */
async function reencode(
  bitmap: ImageBitmap,
  scale: number,
  sourceType: string,
): Promise<{ blob: Blob; mediaType: ImageMediaType }> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this display cannot resize images');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const attempts: { mediaType: ImageMediaType; quality?: number }[] =
    sourceType === 'image/jpeg'
      ? [{ mediaType: 'image/jpeg', quality: 0.92 }, { mediaType: 'image/jpeg', quality: 0.7 }]
      : [
          { mediaType: 'image/png' },
          { mediaType: 'image/jpeg', quality: 0.9 },
          { mediaType: 'image/jpeg', quality: 0.7 },
        ];

  let smallest: { blob: Blob; mediaType: ImageMediaType } | null = null;
  for (const { mediaType, quality } of attempts) {
    const blob = await toBlob(canvas, mediaType, quality);
    if (!blob) continue;
    if (blob.size <= MAX_BYTES) return { blob, mediaType };
    if (!smallest || blob.size < smallest.blob.size) smallest = { blob, mediaType };
  }
  if (!smallest) throw new Error('it could not be re-encoded');
  throw new Error(`it is still ${Math.round(smallest.blob.size / 1024 / 1024)} MB after resizing`);
}

/**
 * Decode, right-size and base64 one pasted image. Throws with a sentence the
 * status line can print — a bad paste is worth saying out loud, never worth
 * standing between the operator and the rest of the prompt.
 */
export async function prepareImage(file: File): Promise<PastedImage> {
  const sourceType = file.type;
  if (!isImageType(sourceType)) throw new Error(`${sourceType || 'that'} is not an image Claude reads`);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('the image data is damaged');
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    // Already small enough to send as it stands. Worth keeping the original bytes
    // rather than round-tripping them: an animated GIF survives, and a screenshot
    // never picks up a generation of compression it didn't need.
    const asIs = scale === 1 && file.size <= MAX_BYTES;
    const { blob, mediaType } = asIs
      ? { blob: file as Blob, mediaType: sourceType }
      : await reencode(bitmap, scale, sourceType);

    const dataUrl = await readDataUrl(blob);
    return {
      id: crypto.randomUUID(),
      mediaType,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      dataUrl,
      width: Math.max(1, Math.round(bitmap.width * scale)),
      height: Math.max(1, Math.round(bitmap.height * scale)),
      bytes: blob.size,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Where the main process serves a stored screenshot from — one scheme of its own,
 * rooted at the cockpit's image store, so an `<img src>` can name a file in there
 * and nothing else. See the `cockpit-image` handler in electron/main.ts.
 */
export function storedImageUrl(file: string): string {
  return `cockpit-image://image/${file.split('/').map(encodeURIComponent).join('/')}`;
}
