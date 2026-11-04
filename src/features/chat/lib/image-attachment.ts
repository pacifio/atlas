import type { ImageAttachment } from "@/types/agents";
import { QUALITY_LADDER, exceedsBudget, targetDimensions } from "./image-policy";

/** A staged image: the wire attachment, plus the file it is, which joins it
 *  to its chip in the prompt (`attachPaths`). */
export type StagedImage = ImageAttachment & { path: string };

/**
 * Shrink an attachment that would not fit the gateway's body cap (D15c).
 *
 * Done once, here, rather than on every turn: the engine replays the whole
 * conversation on each request, so an image re-encoded on the way out would be
 * re-encoded for as long as the thread lives.
 *
 * Failure is not fatal. A browser that cannot decode the image, or a canvas
 * that will not export, leaves the original in place — a too-large attachment
 * that the gateway refuses with a clear `413` is a better outcome than an
 * attachment silently dropped on the floor here.
 */
export async function downscaleAttachment(image: ImageAttachment): Promise<ImageAttachment> {
  if (!exceedsBudget(image.dataBase64.length)) return image;
  try {
    const source = `data:${image.mimeType};base64,${image.dataBase64}`;
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const target = targetDimensions(bitmap.width, bitmap.height);
    const width = target?.width ?? bitmap.width;
    const height = target?.height ?? bitmap.height;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return image;
    // A fresh canvas is transparent and JPEG has no alpha channel, so
    // transparent pixels composite to BLACK — a macOS window capture (rounded
    // corners, drop shadow, routinely over budget) came out with black
    // corners and a black halo (#71). Paint the ground white first.
    // ratchet-allow: the JPEG ground for a window capture (#71), not app chrome.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // Down the quality ladder until it fits. A legible 400 KB JPEG beats a
    // pristine 6 MB PNG the gateway refuses outright.
    for (const quality of QUALITY_LADDER) {
      const encoded = canvas.toDataURL("image/jpeg", quality);
      const data = encoded.slice(encoded.indexOf(",") + 1);
      if (!exceedsBudget(data.length)) {
        return { mimeType: "image/jpeg", dataBase64: data };
      }
    }
    return image;
  } catch {
    return image;
  }
}
