import { Avatar } from './ui';
import { useAuthedImage } from '../lib/use-authed-image';

/**
 * A colleague's face, fetched through the authenticated client.
 *
 * A thin wrapper over `Avatar` that exists so the fetch lives in one place: the
 * endpoint needs an Authorization header, which an `<img src>` cannot carry, so
 * every caller would otherwise have to know about object URLs.
 *
 * Use this for USERS. Leads and contacts keep the plain `Avatar` — they are
 * people outside the organization with no account and therefore no picture, and
 * initials are the right answer for them rather than a gap.
 */
export function UserAvatar({
  name,
  avatarUrl,
  size = 'md',
}: {
  name: string;
  avatarUrl?: string | null;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  // Null while it loads and if it fails, so the initials show throughout
  // rather than a broken image or an empty circle.
  const src = useAuthedImage(avatarUrl);

  return <Avatar name={name} size={size} src={src} />;
}
