// Images to send with a prompt: read, scaled down so a screenshot isn't several
// megabytes (agents shrink big images anyway), and with a small thumbnail kept in
// the conversation to show what was sent.
import type { PromptImage } from "../../shared/protocol.ts";

export const MAX_IMAGES = 4;
/** Claude resizes images above about this on its own, so more pixels only cost time. */
const MAX_EDGE = 1568;
const THUMB_EDGE = 220;
/** Of what's sent; the bridge accepts up to 6 MB of base64, which is 4.5 MB of image. */
const MAX_BYTES = 3_500_000;
const PASS_THROUGH = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface Attached {
  id: string;
  name: string;
  image: PromptImage;
  /** A data: URL of the thumbnail, for showing it. */
  preview: string;
}

const isImage = (f: File) => f.type.startsWith("image/");
export const imageFiles = (list: Iterable<File>): File[] => [...list].filter(isImage);

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the image."));
    r.readAsDataURL(blob);
  });
}

/** Draw `bitmap` at most `edge` pixels on its long side, on white (JPEG has no transparency). */
function draw(bitmap: ImageBitmap, edge: number): HTMLCanvasElement {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the image.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function prepareImage(file: File): Promise<Attached> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || "That"} can't be read as a PNG, JPEG, WebP or GIF image.`);
  }
  try {
    let mimeType: string;
    let blob: Blob;
    const fits = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE;
    if (fits && PASS_THROUGH.has(file.type) && file.size <= MAX_BYTES) {
      // As it is: nothing to gain from re-encoding.
      mimeType = file.type;
      blob = file;
    } else {
      const canvas = draw(bitmap, MAX_EDGE);
      // Screenshots stay PNG (crisp text) while that's small enough; everything else is JPEG.
      let out = file.type === "image/png" ? await toBlob(canvas, "image/png") : null;
      mimeType = "image/png";
      for (const q of [0.92, 0.85, 0.75]) {
        if (out && out.size <= MAX_BYTES) break;
        out = await toBlob(canvas, "image/jpeg", q);
        mimeType = "image/jpeg";
      }
      if (!out || out.size > MAX_BYTES) throw new Error(`${file.name || "The image"} is too big to send, even scaled down.`);
      blob = out;
    }
    const thumbBlob = await toBlob(draw(bitmap, THUMB_EDGE), "image/jpeg", 0.7);
    if (!thumbBlob) throw new Error("Couldn't prepare the image.");
    const [data, thumb] = await Promise.all([base64(blob), base64(thumbBlob)]);
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || "pasted image",
      image: { mimeType, data, thumb },
      preview: `data:image/jpeg;base64,${thumb}`,
    };
  } finally {
    bitmap.close();
  }
}
