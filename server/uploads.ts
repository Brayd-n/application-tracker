import sharp from 'sharp';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export class UploadError extends Error {}

sharp.cache(false);
sharp.concurrency(1);

type Kind = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

// The type is decided by the file's first bytes, never by its name or the browser's Content-Type.
export function sniff(b: Buffer): Kind | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

// Images are decoded and re-encoded: that drops EXIF/GPS and other metadata, and anything hidden
// after the image data. PDFs are kept as uploaded and only ever served as downloads.
export async function sanitize(data: Buffer): Promise<{ data: Buffer; mime: Kind }> {
  if (data.length > MAX_UPLOAD_BYTES) throw new UploadError('Files can be at most 10 MB.');
  const mime = sniff(data);
  if (!mime) throw new UploadError('Only PNG, JPEG, WebP images and PDF files are allowed.');
  if (mime === 'application/pdf') return { data, mime };
  try {
    const img = sharp(data, { limitInputPixels: 50_000_000 }).rotate(); // apply EXIF orientation before it's removed
    const out = mime === 'image/png' ? img.png() : mime === 'image/webp' ? img.webp() : img.jpeg({ quality: 88 });
    return { data: await out.toBuffer(), mime };
  } catch {
    throw new UploadError("That image couldn't be read.");
  }
}

export function safeFilename(name: string): string {
  const clean = name.normalize('NFKC').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(-120).trim();
  return clean || 'file';
}
