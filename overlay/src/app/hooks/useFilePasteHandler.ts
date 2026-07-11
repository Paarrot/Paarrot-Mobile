import { useCallback, ClipboardEventHandler } from 'react';
import { getDataTransferFiles } from '../utils/dom';
import { readClipboardImage, isTauri, isLinux, isCapacitorNative } from '../utils/tauri';

const filesFromClipboardItems = (data: DataTransfer | null): File[] => {
  if (!data?.items) return [];

  const files: File[] = [];
  for (let i = 0; i < data.items.length; i += 1) {
    const item = data.items[i];
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
};

const filesFromHtmlImage = (data: DataTransfer | null): File[] => {
  const html = data?.getData('text/html');
  if (!html) return [];

  const match = html.match(/<img[^>]+src=["'](data:image\/[a-zA-Z+]+;base64,[^"']+)["']/i);
  if (!match?.[1]) return [];

  try {
    const dataUrl = match[1];
    const [meta, base64] = dataUrl.split(',');
    const mime = meta.match(/data:(image\/[a-zA-Z+]+);base64/i)?.[1] ?? 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const ext = mime.split('/')[1]?.replace('+xml', '') || 'png';
    return [new File([bytes], `clipboard-image.${ext}`, { type: mime })];
  } catch {
    return [];
  }
};

const getClipboardFiles = (data: DataTransfer | null): File[] => {
  if (!data) return [];

  const fromFiles = getDataTransferFiles(data);
  if (fromFiles && fromFiles.length > 0) return fromFiles;

  const fromItems = filesFromClipboardItems(data);
  if (fromItems.length > 0) return fromItems;

  return filesFromHtmlImage(data);
};

/** Async Clipboard API fallback (when paste event has no file payload). */
const filesFromClipboardApi = async (): Promise<File[]> => {
  if (!navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) continue;
        const blob = await item.getType(type);
        const ext = type.split('/')[1]?.replace('+xml', '') || 'png';
        files.push(new File([blob], `clipboard-image.${ext}`, { type }));
      }
    }
    return files;
  } catch {
    return [];
  }
};

/**
 * Paste handler for RoomInput. Supports clipboard images via files, DataTransferItem
 * list, HTML data-URL fallbacks, and Clipboard API (common on mobile WebViews).
 * On Capacitor Android, native OnReceiveContent also routes images into the share pipeline.
 */
export const useFilePasteHandler = (onPaste: (file: File[]) => void): ClipboardEventHandler =>
  useCallback(
    async (evt) => {
      const files = getClipboardFiles(evt.clipboardData);
      if (files.length > 0) {
        evt.preventDefault();
        evt.stopPropagation();
        onPaste(files);
        return;
      }

      // On Linux with Tauri, browser clipboard API doesn't work for images.
      if (isTauri() && isLinux()) {
        const clipboardImage = await readClipboardImage();
        if (clipboardImage) {
          evt.preventDefault();
          evt.stopPropagation();
          onPaste([clipboardImage]);
          return;
        }
      }

      // Mobile WebView / Capacitor: paste events often omit file payloads.
      if (isCapacitorNative()) {
        const apiFiles = await filesFromClipboardApi();
        if (apiFiles.length > 0) {
          evt.preventDefault();
          evt.stopPropagation();
          onPaste(apiFiles);
        }
      }
    },
    [onPaste]
  );
