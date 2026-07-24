import FileSaver from 'file-saver';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { downloadMedia } from './matrix';
import { getCurrentAccessToken } from './auth';

interface AndroidShareHandlerSavePlugin {
  saveFile(options: {
    filename: string;
    mimeType?: string;
    base64: string;
  }): Promise<{ saved: boolean; shared?: boolean; uri?: string }>;
  shareFile(options: {
    filename: string;
    mimeType?: string;
    base64: string;
  }): Promise<{ shared: boolean }>;
}

const AndroidShareHandler = registerPlugin<AndroidShareHandlerSavePlugin>('AndroidShareHandler');

const isAndroidNative = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Convert a Blob to raw base64 (no data: prefix). */
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read blob as base64'));
        return;
      }
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });

const guessMimeFromName = (filename: string): string | undefined => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
    txt: 'text/plain',
  };
  return map[ext];
};

/**
 * Persist a Blob to disk. On Capacitor Android, uses MediaStore via the native
 * ShareHandler plugin (FileSaver / `<a download>` does not work in WebView).
 * Elsewhere falls back to FileSaver.
 */
export const saveMediaBlob = async (blob: Blob, filename: string): Promise<void> => {
  if (isAndroidNative()) {
    const base64 = await blobToBase64(blob);
    const mimeType = blob.type || guessMimeFromName(filename) || 'application/octet-stream';
    await AndroidShareHandler.saveFile({ filename, mimeType, base64 });
    return;
  }
  FileSaver.saveAs(blob, filename);
};

/**
 * Fetch media (auth download or blob:/http URL) and save it via [saveMediaBlob].
 */
export const downloadAndSaveMedia = async (
  src: string,
  filename: string,
  accessToken?: string | null
): Promise<void> => {
  let blob: Blob;
  try {
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`Failed to fetch ${src}`);
      blob = await res.blob();
    } else {
      blob = await downloadMedia(src, accessToken ?? getCurrentAccessToken());
    }
  } catch (error) {
    console.warn('[saveMedia] downloadMedia failed, trying fetch fallback:', error);
    const res = await fetch(src);
    if (!res.ok) throw error;
    blob = await res.blob();
  }
  await saveMediaBlob(blob, filename);
};
