# Home page demo video

Drop a video in this folder and it appears on the home page, below the feature
sections. Remove it and the section disappears. Nothing else needs changing.

**There is no video here yet.** The section renders nothing until you add one —
deliberately, because a broken player or a "coming soon" placeholder tells a
prospective customer the product is unfinished more loudly than an absent
section does.

## Adding one

1. Put the file here as `demo.mp4` (H.264 MP4 — the only format every browser
   and both mobile platforms play without a fallback).
2. Optionally add `poster.jpg`, the still frame shown before playback, and
   `captions.vtt`.
3. Create `demo.json` beside them:

```json
{
  "url": "/demo/demo.mp4",
  "poster": "/demo/poster.jpg",
  "captions": "/demo/captions.vtt",
  "title": "See LeadFlow in ninety seconds",
  "description": "A lead arrives, gets an owner and a follow-up date, and is answered on WhatsApp — without leaving the app.",
  "durationLabel": "1 min 32 sec · no sound needed"
}
```

Only `url` is required. Everything else falls back to sensible copy.

## Practical notes

- **Keep it under about 20 MB.** It is served from the same origin as the app,
  so a large file competes with the app's own assets for bandwidth. It is
  loaded with `preload="metadata"`, so visitors who never press play only fetch
  a few kilobytes — but the ones who do press play should not wait.
- **It does not autoplay**, and that is on purpose. A video that starts by
  itself, especially with sound, is the fastest way to make somebody close the
  tab.
- **1280×720 is plenty.** The player is capped at 4xl and shown at 16:9.
- **Add captions.** Many people watch with sound off, and a screen-recorded
  product demo is unusable without them if it relies on narration.

## What to record

The pitch is "no lead left behind", so show that rather than a tour of the
menus:

1. A lead arriving and getting an owner and a follow-up date.
2. The follow-up going overdue, and the app surfacing it.
3. A WhatsApp conversation being answered from the inbox and linked to a lead.

Use the seeded demo data (see [`docs/local-development.md`](../../../../docs/local-development.md))
so the screen is full of realistic figures rather than empty states. Sign in as
`owner@northwind.example`.

**Do not record against real customer data.** The seeded organizations are
entirely fictional, which is why they exist.
