/** The NeuroCapture logo. Long-press opens the settings menu (decision 041). */
import { useRef } from 'react';

const LONG_PRESS_MS = 1200;

export function Logo({ onLongPress }: { onLongPress: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  return (
    <div
      className="nc-gradient flex size-8 select-none items-center justify-center rounded-[10px] text-white"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="logo"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <path d="M16 10l5-3v10l-5-3" />
      </svg>
    </div>
  );
}
