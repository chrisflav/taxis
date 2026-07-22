// One icon vocabulary for the interface chrome.
//
// These were emoji — 🔔, 🔒, 🕓, 🗑 — which every platform renders in its own full colour, so they
// sat in the palette like stickers and ignored the theme entirely. Drawn here instead: one grid,
// one stroke weight, `currentColor`, so an icon is whatever colour the text beside it is and
// follows light and dark without being told.
//
// Emoji that carry *content* rather than chrome (the 🤖 marker on a bot actor) are left alone —
// there the colour is the point.

interface IconProps {
  /** Rendered size in px. The geometry is drawn on a 24px grid and scales down cleanly. */
  size?: number;
}

function Svg({ size = 15, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function BellIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 8.6a6 6 0 1 0-12 0c0 5.7-2.1 7.1-2.1 7.1h16.2S18 14.3 18 8.6Z" />
      <path d="M13.7 19.4a2 2 0 0 1-3.4 0" />
    </Svg>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4.6" y="10.4" width="14.8" height="9.8" rx="2.2" />
      <path d="M8.1 10.4V7.3a3.9 3.9 0 0 1 7.8 0v3.1" />
    </Svg>
  );
}

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.1V12l3.2 1.9" />
    </Svg>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.6 6.9h14.8M9.6 6.9V5.2a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v1.7" />
      <path d="M6.7 6.9 7.5 19a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.8-12.1" />
    </Svg>
  );
}

export function SunIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 1.8v2.4M12 19.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M1.8 12h2.4M19.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </Svg>
  );
}

export function MoonIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20.5 14.8A8.8 8.8 0 1 1 9.2 3.5a6.9 6.9 0 0 0 11.3 11.3Z" />
    </Svg>
  );
}

/** A lock beside an issue's title or row, marking it as frozen for editing. */
export function LockedMark({ size = 13 }: IconProps) {
  return (
    <span className="locked-mark" title="Locked for editing" role="img" aria-label="Locked">
      <LockIcon size={size} />
    </span>
  );
}
