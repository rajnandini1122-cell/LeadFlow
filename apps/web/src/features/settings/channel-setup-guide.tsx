import { useState } from 'react';
import type { Channel } from '../omnichannel/use-conversations';

/**
 * What to do before you can connect a channel.
 *
 * Every value the connect form asks for comes from a Meta dashboard, under a
 * name that does not match ours and behind a setup people do once and then
 * forget. Somebody arriving at an empty form has no way to know that "Phone
 * number ID" is a 15-digit number from WhatsApp → API Setup and emphatically
 * not their phone number.
 *
 * Collapsed by default: it is first-run help, and an expanded wall of text
 * above the form would be in the way every time afterwards.
 *
 * Deliberately does NOT link out to deep Meta URLs. Those move, and a dead
 * link in a setup guide is worse than a described path somebody can search
 * for. The steps name the screens instead.
 */

interface GuideStep {
  title: string;
  detail: string;
}

const GUIDES: Record<Channel, { intro: string; steps: GuideStep[]; gotcha: string }> = {
  WHATSAPP: {
    intro:
      'You need a Meta app with WhatsApp added, and a WhatsApp Business number. Meta charges per conversation; LeadFlow does not add anything to that.',
    steps: [
      {
        title: 'Create a Meta app',
        detail:
          'developers.facebook.com → My Apps → Create App → Business. Then add the WhatsApp product to it.',
      },
      {
        title: 'Find your Phone number ID',
        detail:
          'WhatsApp → API Setup. It is a long numeric ID shown under the number itself — NOT the phone number. Copy it into "Phone number ID".',
      },
      {
        title: 'Copy the WhatsApp Business Account ID',
        detail:
          'On the same screen, just below. Optional for sending messages, but REQUIRED if you want to use message templates.',
      },
      {
        title: 'Create a permanent access token',
        detail:
          'Business Settings → Users → System Users → Add. Give it the whatsapp_business_messaging permission, and also whatsapp_business_management if you want templates. Generate a token with no expiry.',
      },
      {
        title: 'Point the webhook at LeadFlow',
        detail:
          'WhatsApp → Configuration → Webhook. Use the callback URL and verify token from your deployment, and subscribe to the "messages" field. Without this, incoming messages never arrive.',
      },
    ],
    gotcha:
      'The temporary 24-hour token on the API Setup page works for a first test, then expires and moves the channel to ERROR. Use a system user token for anything real.',
  },

  INSTAGRAM: {
    intro:
      'Instagram DMs need a PROFESSIONAL account (Business or Creator) linked to a Facebook Page. A personal account cannot be connected.',
    steps: [
      {
        title: 'Convert the account and link a Page',
        detail:
          'In the Instagram app: Settings → Account type and tools → Switch to professional account. Then link it to a Facebook Page.',
      },
      {
        title: 'Allow access to messages',
        detail:
          'Instagram app → Settings → Messages and story replies → Allow access to messages. If this is off, nothing reaches LeadFlow no matter what else is configured.',
      },
      {
        title: 'Add Instagram to your Meta app',
        detail:
          'In the same Meta app as WhatsApp, add the Instagram product and connect the professional account.',
      },
      {
        title: 'Copy the account ID and token',
        detail:
          'The Instagram professional account ID goes in "Account ID". Generate a token with instagram_manage_messages and pages_manage_metadata.',
      },
      {
        title: 'Subscribe the webhook',
        detail:
          'Subscribe to the "messages" field for Instagram, using the same callback URL and verify token.',
      },
    ],
    gotcha:
      'Instagram only delivers messages from people who are not following you after they message you first. There is no way to open a conversation from LeadFlow.',
  },

  FACEBOOK: {
    intro:
      'Messenger connects through a Facebook Page. You need admin access to that Page.',
    steps: [
      {
        title: 'Add Messenger to your Meta app',
        detail: 'In the same Meta app, add the Messenger product.',
      },
      {
        title: 'Link the Page',
        detail:
          'Messenger → Settings → Access Tokens → Add or Remove Pages. Choose the Page you want conversations from.',
      },
      {
        title: 'Copy the Page ID and token',
        detail:
          'The Page ID goes in "Account ID". Generate a Page access token with pages_messaging and pages_manage_metadata.',
      },
      {
        title: 'Subscribe the webhook',
        detail:
          'Subscribe the Page to the "messages" field, using the same callback URL and verify token.',
      },
    ],
    gotcha:
      'A Page access token is tied to the person who generated it. If they lose Page admin rights the token stops working and the channel moves to ERROR.',
  },
};

const CHANNEL_LABELS: Record<Channel, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook Messenger',
};

export function ChannelSetupGuide({ channel }: { channel: Channel }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const guide = GUIDES[channel];

  if (!guide) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-slate-800">
          First time? How to get these {CHANNEL_LABELS[channel]} details
        </span>
        <span aria-hidden="true" className="shrink-0 text-slate-400">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-200 px-4 py-4">
          <p className="text-xs text-pretty text-slate-600">{guide.intro}</p>

          <ol className="mt-3 space-y-3">
            {guide.steps.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-800">{step.title}</p>
                  <p className="mt-0.5 text-xs text-pretty text-slate-600">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          {/*
            * The thing that actually catches people out, called out separately.
            * It is the difference between "connected" and "connected and still
            * working next week".
            */}
          <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-pretty text-amber-800">
            <strong className="font-medium">Watch out:</strong> {guide.gotcha}
          </p>

          <p className="mt-3 text-[11px] text-slate-500">
            Your access token is encrypted before it is stored and is never shown again — only
            its last four characters. LeadFlow never sees your Meta password.
          </p>
        </div>
      )}
    </div>
  );
}
