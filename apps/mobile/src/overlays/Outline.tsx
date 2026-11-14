/**
 * Static per-test framing guides (DEV_PLAN §8.2 `framing.overlay`). M3 draws the guide only; in M5
 * its colour follows the positioning checks and M4 adds tracked points.
 */
export type OverlayKind = 'hand_outline' | 'upper_body' | 'full_body' | 'face_oval';

const HAND =
  'M152 560 C150 530 148 505 142 488 C132 470 106 446 94 424 C86 408 92 392 106 390 C118 389 126 398 134 410 C142 422 148 428 152 424 L152 276 C152 260 176 260 176 276 L176 388 C176 395 182 395 182 388 L182 256 C182 238 208 238 208 256 L208 388 C208 395 214 395 214 388 L214 268 C214 250 240 250 240 268 L240 396 C240 403 246 403 246 396 L246 304 C246 288 268 288 268 304 L268 440 C268 480 262 520 254 560';

const UPPER_BODY =
  'M422 58 a40 40 0 1 1 -0.1 0 M372 160 C390 140 454 140 472 160 L520 178 L740 178 C752 178 752 202 740 202 L520 202 L500 210 L490 330 L354 330 L344 210 L324 202 L104 202 C92 202 92 178 104 178 L324 178 Z';

/** Guide plus safe-zone corner brackets; colour comes from the caller (state in M5). */
export function Outline({
  kind,
  color = '#FFFFFF',
  dashed = true,
}: {
  kind: OverlayKind;
  color?: string;
  dashed?: boolean;
}) {
  const portrait = kind === 'hand_outline' || kind === 'face_oval';
  const w = portrait ? 390 : 844;
  const h = portrait ? 844 : 390;
  const m = 0.05;
  const L = 30;
  const [x0, y0, x1, y1] = [w * m, h * m, w * (1 - m), h * (1 - m)];
  const dash = dashed ? '10 8' : undefined;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-0 h-full w-full"
      role="img"
      aria-label={kind}
      data-testid="outline"
    >
      <path
        d={`M${x0} ${y0 + L} V${y0} H${x0 + L} M${x1 - L} ${y0} H${x1} V${y0 + L} M${x1} ${y1 - L} V${y1} H${x1 - L} M${x0 + L} ${y1} H${x0} V${y1 - L}`}
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity={0.75}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {kind === 'hand_outline' && <Guide d={HAND} color={color} dash={dash} />}
      {kind === 'upper_body' && <Guide d={UPPER_BODY} color={color} dash={dash} />}
      {kind === 'face_oval' && (
        <g>
          <ellipse
            cx={195}
            cy={380}
            rx={125}
            ry={165}
            fill={color}
            fillOpacity={0.06}
            stroke={color}
            strokeOpacity={0.22}
            strokeWidth={12}
          />
          <ellipse
            cx={195}
            cy={380}
            rx={125}
            ry={165}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeDasharray={dash}
          />
          <path
            d="M120 350 H270"
            stroke={color}
            strokeOpacity={0.4}
            strokeWidth={2}
            strokeDasharray="4 6"
          />
        </g>
      )}
      {kind === 'full_body' && (
        <g>
          <path d="M0 318 H844 V344 H0 Z" fill="#5BE3A0" fillOpacity={0.1} />
          <line x1={0} y1={331} x2={844} y2={331} stroke="#8C96A5" strokeWidth={2} />
          <rect x={120} y={327} width={10} height={8} rx={1} fill="#F2D33A" />
          <rect x={720} y={327} width={10} height={8} rx={1} fill="#F2D33A" />
          <rect
            x={40}
            y={60}
            width={160}
            height={280}
            rx={18}
            fill={color}
            fillOpacity={0.05}
            stroke={color}
            strokeWidth={2.5}
            strokeDasharray={dash ?? '10 8'}
          />
          <g
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx={96} cy={126} r={17} />
            <path d="M94 146 L88 240 M92 162 L110 202 L132 208 M88 240 L142 244 L148 322 L170 326" />
          </g>
        </g>
      )}
    </svg>
  );
}

function Guide({ d, color, dash }: { d: string; color: string; dash?: string }) {
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeOpacity={0.22}
        strokeWidth={12}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill={color}
        fillOpacity={0.06}
        stroke={color}
        strokeWidth={3}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}
