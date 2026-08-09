import { Capacitor, registerPlugin } from '@capacitor/core';
import { registerMediaSaver } from './saveMedia';

interface AndroidShareHandlerSavePlugin {
  saveFile(options: {
    filename: string;
    mimeType?: string;
    base64: string;
  }): Promise<{ saved: boolean; shared?: boolean; uri?: string }>;
}

const AndroidShareHandler = registerPlugin<AndroidShareHandlerSavePlugin>('AndroidShareHandler');

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
 * Wire Capacitor Android MediaStore saves into the core saveMedia helpers.
 * Call once at app startup from the mobile overlay entry.
 */
export function registerAndroidMediaSaver(): void {
  if (!(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android')) {
    return;
  }

  registerMediaSaver(async (blob, filename) => {
    const base64 = await blobToBase64(blob);
    const mimeType = blob.type || guessMimeFromName(filename) || 'application/octet-stream';
    await AndroidShareHandler.saveFile({ filename, mimeType, base64 });
  });
}
