# 055: The phone app in the Horizon+ look (v31)

- **Status:** built on branch `claude/new-ui-for-app`, not merged.
- **Approval:** the user approved the canvas v31 app mocks on 19 Nov 2026: "make it as it is in new
  with new color theme applied; rest of the screens suggested are okay you can build".

## What changed

- **Theme tokens:** `apps/mobile/src/index.css` now uses the same colour names and values as the
  dashboards (ink, sub, muted, line, edge, soft, ground, card, brand, brand-ink, brand-soft,
  coral, ok, warn, bad and their soft versions, hero-a/b/c, hill, glass).
  - Every evening (dark) value is swapped under `data-theme="dark"`, or by the phone's dark mode
    for "Same as this phone".
  - Camera screens use their own `cam-*` tokens and are dark at any time, as before.
- **Hard-coded colours:** the old blue colours in the screens became tokens (for example
  `text-[#3D4552]` → `text-sub`, `bg-white` → `bg-card`). The camera and engineering test screens
  keep white where the camera image is behind them.
- **Kit:**
  - buttons are 52 px pills; primary uses the indigo→violet gradient (`.nc-gradient`), secondary
    is a lined card;
  - cards are rounded 24 px with a soft shadow and no border;
  - radios are soft tiles, and the chosen one is outlined in indigo.
- **Greeting:**
  - the dashboards' sky (`.nc-hero`), with hills along the bottom;
  - a sun in the morning and afternoon; a moon and stars in the evening;
  - the logo is the gradient square.
- **Welcome screen:** the same layout as before, with the theme's sky, the gradient logo, the
  patient choice in the gradient and the clinic choice as a white card.
- **Other screens:**
  - the first to-do on Home is outlined in indigo;
  - chosen chips (medicine state, filters, ranks) and step numbers use the gradient;
  - "Session complete" draws a gradient tick;
  - the review player's play button stays white in both looks.
- **Appearance (Settings):**
  - choices are Automatic (the default), Same as this phone, Light and Dark;
  - Automatic is dark from `appearance.darkFromHour` (18) until `appearance.lightFromHour` (6) in
    `config/platform.json`, the same hours as the dashboards, and the app checks every minute;
  - strings are in English and Hindi.

## Not changed

- **Recording:** steps, test lengths, the native recording and its timer, quality checks, uploads
  and consent are unchanged.
- **Test-mode banner:** keeps its purple so it is never mistaken for a real session.

## Tests

- **App unit tests:** 88, including `test/appearance.test.ts` and `test/lengths.test.ts`.
- **App e2e:** 52/52, including the accessibility checks.
- **Screens checked by hand in mock mode:** the patient flow (welcome to Session complete) and the
  clinic phone, in light and dark.
