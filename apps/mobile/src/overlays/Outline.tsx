/**
 * Static per-test framing guides (DEV_PLAN §8.2 `framing.overlay`). M3 draws the guide only; in M5
 * its colour follows the positioning checks and M4 adds tracked points.
 */
export type OverlayKind =
  'hand_outline' | 'upper_body' | 'one_arm' | 'side_reach' | 'full_body' | 'face_oval';

const HAND =
  'M152 560 C150 530 148 505 142 488 C132 470 106 446 94 424 C86 408 92 392 106 390 C118 389 126 398 134 410 C142 422 148 428 152 424 L152 276 C152 260 176 260 176 276 L176 388 C176 395 182 395 182 388 L182 256 C182 238 208 238 208 256 L208 388 C208 395 214 395 214 388 L214 268 C214 250 240 250 240 268 L240 396 C240 403 246 403 246 396 L246 304 C246 288 268 288 268 304 L268 440 C268 480 262 520 254 560';

/**
 * Patient facing the camera with the RIGHT arm out to the side (image left on the un-mirrored
 * back camera), thumb up. Mirrored for the left arm.
 */
const ONE_ARM =
  'M560 52 a38 38 0 1 1 -0.1 0 M610 160 L640 176 L632 330 L488 330 L480 202 L140 202 C126 202 126 178 140 178 L150 178 L150 156 C150 146 168 146 168 156 L168 178 L480 178 L500 162 C515 146 595 146 610 160 Z';

const UPPER_BODY =
  'M422 58 a40 40 0 1 1 -0.1 0 M372 160 C390 140 454 140 472 160 L520 178 L740 178 C752 178 752 202 740 202 L520 202 L500 210 L490 330 L354 330 L344 210 L324 202 L104 202 C92 202 92 178 104 178 L324 178 Z';

/** Guide plus safe-zone corner brackets; colour comes from the caller (state in M5). */
export function Outline({
  kind,
  color = '#FFFFFF',
  dashed = true,
  side = null,
}: {
  kind: OverlayKind;
  color?: string;
  dashed?: boolean;
  /** Tested side: the hand guide is drawn as a left hand and the arm guide as a right arm. */
  side?: 'R' | 'L' | null;
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
      {kind === 'hand_outline' && (
        // The path spans x 86–268; mirror about its own centre (177) so it stays in place.
        <g
          transform={side === 'R' ? 'translate(354 0) scale(-1 1)' : undefined}
          data-testid={side === 'R' ? 'hand-guide-right' : 'hand-guide-left'}
        >
          <Guide d={HAND} color={color} dash={dash} />
        </g>
      )}
      {kind === 'upper_body' && <Guide d={UPPER_BODY} color={color} dash={dash} />}
      {kind === 'one_arm' && (
        // Path spans x 126–640; shift it to the centre, mirror about the viewBox centre for L.
        <g
          transform={
            side === 'L' ? 'translate(844 0) scale(-1 1) translate(39 0)' : 'translate(39 0)'
          }
          data-testid={side === 'L' ? 'arm-guide-left' : 'arm-guide-right'}
        >
          <Guide d={ONE_ARM} color={color} dash={dash} />
        </g>
      )}
      {kind === 'side_reach' && (
        // Drawn for the right hand: patient on the left facing right, right side to the camera.
        // Mirrored for the left hand (patient on the right, facing left).
        <g
          transform={side === 'L' ? 'translate(844 0) scale(-1 1)' : undefined}
          data-testid={side === 'L' ? 'reach-guide-left' : 'reach-guide-right'}
        >
          {/* Patient seated side-on, reaching towards the examiner's finger. */}
          <rect
            x={60}
            y={40}
            width={300}
            height={285}
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
            <circle cx={190} cy={100} r={30} />
            <path d="M185 132 L175 260 M182 160 L250 170 L320 158 M175 250 L270 252 L276 312" />
          </g>
          {/* Examiner's finger: moves anywhere inside this box. */}
          <rect
            x={430}
            y={40}
            width={340}
            height={250}
            rx={18}
            fill="#F2D33A"
            fillOpacity={0.06}
            stroke="#F2D33A"
            strokeWidth={2.5}
            strokeDasharray="6 8"
          />
          <g fill="#F2D33A" fillOpacity={0.9}>
            <circle cx={500} cy={95} r={7} />
            <circle cx={690} cy={130} r={7} />
            <circle cx={560} cy={225} r={7} />
            <circle cx={720} cy={240} r={7} />
          </g>
        </g>
      )}
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
