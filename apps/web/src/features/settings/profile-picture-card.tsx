import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, apiDelete, apiPost } from '../../lib/api-client';
import { Avatar, Card, CardHeader } from '../../components/ui';
import { forgetAuthedImage, useAuthedImage } from '../../lib/use-authed-image';
import { useAuth } from '../auth/auth-context';

/**
 * Your own profile picture.
 *
 * Only ever the signed-in user's own — there is no way to change somebody
 * else's face, which removes "an admin changed my photo" before it can be
 * asked.
 *
 * The image is resized in the BROWSER before it is sent. A phone camera
 * produces several megabytes, an avatar is displayed at 36 pixels, and
 * uploading the original would waste the user's data allowance to store
 * something no one will ever see at that resolution.
 */

/** Displayed at 36px at most; 256 is generous for a high-density screen. */
const TARGET_SIZE = 256;

/**
 * Redraws an image at avatar size, as a JPEG.
 *
 * Square-cropped from the centre so a portrait photograph keeps the face
 * rather than being squashed. Falls back to the original file if anything
 * about the canvas path fails — an oversized upload the server then rejects is
 * a clearer outcome than a silent failure with no picture.
 */
async function resize(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;

    const context = canvas.getContext('2d');
    if (!context) return file;

    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      TARGET_SIZE,
      TARGET_SIZE,
    );
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.85);
    });

    return blob ?? file;
  } catch {
    return file;
  }
}

export function ProfilePictureCard(): React.JSX.Element {
  const { user, refreshUser } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const currentUrl = user?.avatarUrl ?? null;
  const src = useAuthedImage(currentUrl);

  /**
   * Both mutations re-read the session, which is what carries avatarUrl.
   *
   * The old object URL is released first: the new picture has a new versioned
   * URL and is fetched fresh, so holding the previous blob for the life of the
   * page would leak it.
   */
  const refreshSession = (): void => {
    forgetAuthedImage(currentUrl);
    void refreshUser();
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      // A stable name: the server detects the type from the bytes and ignores
      // this entirely, so it exists only to satisfy multipart.
      form.append('file', await resize(file), 'avatar.jpg');
      return apiPost<{ avatarUrl: string }>('/users/me/avatar', form);
    },
    onSuccess: refreshSession,
    onError: (error) =>
      setFailure(
        error instanceof ApiError ? error.message : 'Could not upload that image.',
      ),
  });

  const remove = useMutation({
    mutationFn: () => apiDelete('/users/me/avatar'),
    onSuccess: refreshSession,
    onError: () => setFailure('Could not remove the picture.'),
  });

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset immediately, so choosing the SAME file again still fires onChange.
    event.target.value = '';
    if (!file) return;

    setFailure(null);
    upload.mutate(file);
  };

  const busy = upload.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader title="Profile picture" />
      <div className="space-y-4 p-5">
        <div className="flex items-center gap-4">
          <span className="[&>*]:h-16 [&>*]:w-16 [&>*]:text-lg">
            <Avatar name={user?.fullName ?? ''} src={src} />
          </span>
          <div className="min-w-0 text-xs text-pretty text-slate-500">
            Shown beside your name across LeadFlow. JPEG or PNG. Large images are
            resized before they are sent.
          </div>
        </div>

        {failure && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {failure}
          </p>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          onChange={choose}
          className="hidden"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : currentUrl ? 'Change picture' : 'Upload a picture'}
          </button>

          {currentUrl && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setFailure(null);
                remove.mutate();
              }}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
