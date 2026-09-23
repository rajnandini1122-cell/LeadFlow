# Home page hero background

Drop an image in this folder and it appears behind the hero. Remove it and the
hero falls back to its CSS gradient. Nothing else needs changing.

**There is no image here yet**, so the gradient is currently the whole
background. That is a working state, not a missing one.

## Adding one

Name the file `background` with any of these extensions — the first one found
wins, so WebP is preferred where you have it:

```
background.webp     ← preferred, typically half the size of the same JPEG
background.jpg
background.jpeg
background.png
```

That is the whole setup. No code change, no manifest.

## Practical notes

- **Keep it under about 400 KB.** It is the largest thing on the page and the
  first thing a visitor waits for. A 1920×1080 WebP at quality 75 is usually
  well under that.
- **1920×1080 is plenty.** It is displayed full-bleed behind the hero and
  cropped with `background-size: cover`, so anything larger is wasted bytes.
- **The centre gets covered.** The headline, subheading and buttons sit over
  the middle of the image. Choose something whose interest is towards the
  edges — a busy centre will be hidden.
- **A white scrim is applied over it automatically**, at 75% with a slight
  blur. That is deliberate and not adjustable per image: dark headline text
  over an arbitrary photograph is a contrast failure waiting for the first
  bright picture somebody picks. The scrim is what makes it safe to allow any
  image at all.

  The consequence is that the image reads as a soft texture rather than a
  photograph you look at. If you want it more prominent, lower the opacity in
  `home-page.tsx` (`bg-white/75`) — but check the headline is still readable
  on the image you chose, at both desktop and mobile widths.

## What works well

Abstract and low-contrast: soft gradients, blurred shapes, subtle topography,
a quiet workspace shot. Avoid anything with text, faces near the centre, or
hard high-contrast edges behind the headline.

**Do not use a stock photograph you do not have a licence for**, and do not use
a screenshot containing real customer data — the seeded demo organizations
exist precisely so screenshots can be taken safely.
