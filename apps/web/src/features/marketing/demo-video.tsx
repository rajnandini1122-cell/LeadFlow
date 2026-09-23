import { useEffect, useState } from 'react';

/**
 * The product demo on the home page.
 *
 * Follows the same rule as the Android download card: it shows what has
 * actually been published, or it shows nothing. A visitor deciding whether to
 * trust LeadFlow is exactly the wrong person to show a broken player or a
 * "coming soon" placeholder to — both say the product is unfinished more
 * loudly than an absent section does.
 *
 * A video is dropped in as a file, not committed as code. See
 * `apps/web/public/demo/README.md`.
 */

interface DemoManifest {
  /** Path to the video, served from public/. */
  url: string;
  /** Optional poster frame shown before playback. */
  poster?: string;
  title?: string;
  description?: string;
  /** For the caption under the player. Purely informational. */
  durationLabel?: string;
  /** A captions track. Strongly encouraged; see the README. */
  captions?: string;
}

export function DemoVideo(): React.JSX.Element | null {
  const [demo, setDemo] = useState<DemoManifest | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/demo/demo.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: DemoManifest | null) => {
        if (!cancelled && data?.url) setDemo(data);
      })
      .catch(() => {
        // No demo published. The page simply does not have this section.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!demo) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-balance text-slate-900">
          {demo.title ?? 'See LeadFlow in ninety seconds'}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-pretty text-slate-600">
          {demo.description ??
            'A lead arrives, gets an owner and a follow-up date, and is answered on WhatsApp — without leaving the app.'}
        </p>
      </div>

      <div className="mx-auto mt-8 max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-xl shadow-slate-200/60">
        {/*
          * `controls` and no autoplay, deliberately.
          *
          * A video that starts on its own — especially with sound — is the
          * fastest way to make somebody close the tab. `preload="metadata"`
          * fetches only enough to show the duration, so the page stays quick
          * for the majority who never press play.
          */}
        <video
          className="aspect-video w-full"
          controls
          preload="metadata"
          playsInline
          {...(demo.poster ? { poster: demo.poster } : {})}
        >
          <source src={demo.url} type="video/mp4" />
          {demo.captions && (
            <track kind="captions" src={demo.captions} srcLang="en" label="English" default />
          )}
          Your browser cannot play this video.
        </video>
      </div>

      {demo.durationLabel && (
        <p className="mt-3 text-center text-xs text-slate-400">{demo.durationLabel}</p>
      )}
    </section>
  );
}
