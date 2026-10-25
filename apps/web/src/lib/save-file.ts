import { isNativeApp } from './platform';

/**
 * Hands a file to the user: a download in a browser, the share sheet in the app.
 *
 * The browser path is the usual object URL and `<a download>`. Inside the
 * Android WebView that path does nothing at all — Capacitor declines to open a
 * `blob:` URL and the WebView has no download handler — so an export or a
 * quotation download silently vanished. In the app the file is written to the
 * app's cache and offered through Android's share sheet instead, which is also
 * what a rep wants: send the quotation on WhatsApp, save it to Drive or Files.
 *
 * The cache needs no storage permission, and Android clears it on its own.
 */
export async function saveFile(blob: Blob, fileName: string): Promise<void> {
  if (isNativeApp()) {
    await shareFromApp(blob, fileName);
    return;
  }

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Let the click start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

async function shareFromApp(blob: Blob, fileName: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  const written = await Filesystem.writeFile({
    path: `shared/${Date.now()}-${safeName(fileName)}`,
    data: await toBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });

  try {
    await Share.share({ title: fileName, files: [written.uri], dialogTitle: `Share ${fileName}` });
  } catch (error) {
    // Closing the share sheet is a choice, not a failure.
    if (error instanceof Error && /cancel/i.test(error.message)) return;
    throw error;
  }
}

/** A name the Android file system and every share target will accept. */
export function safeName(fileName: string): string {
  const cleaned = [...fileName]
    .map((char) => (char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? '_' : char))
    .join('');
  return cleaned.slice(-120) || 'file';
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    // "data:<type>;base64,<data>" — Filesystem wants only the data.
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(blob);
  });
}
