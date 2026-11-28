import { useId, type ReactNode } from "react";
import type { Color, PieceType } from "../engine/model";

interface PieceGlyphProps {
  type: PieceType;
  color: Color;
  className?: string;
}

interface Ink {
  bodyFill: string;
  gradStart: string;
  gradMid: string;
  gradEnd: string;
  wingStart: string;
  wingEnd: string;
  rim: string;
  detail: string;
  gem: string;
  eye: string;
}

const palette: Record<Color, Ink> = {
  white: {
    bodyFill: "url(#g)",
    gradStart: "#fffbf2",
    gradMid: "#f0dbb8",
    gradEnd: "#cfa977",
    wingStart: "#e7cda3",
    wingEnd: "#b88c58",
    rim: "#3d1e2c",
    detail: "#9f6234",
    gem: "#e13f60",
    eye: "#ff8c3a",
  },
  black: {
    bodyFill: "url(#g)",
    gradStart: "#4c3b58",
    gradMid: "#291e32",
    gradEnd: "#150e1c",
    wingStart: "#392a45",
    wingEnd: "#120b18",
    rim: "#f2d2a0",
    detail: "#d79a74",
    gem: "#ff6b8b",
    eye: "#ffaa44",
  },
};

function artwork(ink: Ink, gradId: string, gemGradId: string, wingGradId: string): Record<PieceType, ReactNode> {
  const fill = `url(#${gradId})`;
  const gemFill = `url(#${gemGradId})`;
  const wingFill = `url(#${wingGradId})`;
  return {
    king: (
      <>
        <path d="M24 3v11m-5.5-6h11" strokeWidth="2.6" />
        <path d="M17 31c-2-5-7-7-7-12 0-4 3-7 7-7 3 0 5 1 7 4 2-3 4-4 7-4 4 0 7 3 7 7 0 5-5 7-7 12Z" fill={fill} />
        <path d="M17 31h14l3.5 5H13.5ZM13.5 36h21l3 4v3h-27v-3Z" fill={fill} />
        <path d="M24 16v11m-7 1h14" fill="none" stroke={ink.detail} strokeWidth="1.4" />
        <circle cx="24" cy="21.5" r="1.7" fill={gemFill} stroke="none" />
      </>
    ),
    queen: (
      <>
        <path d="m12 15 6.5 6L24 9l5.5 12 6.5-6-4.5 16h-15Z" fill={fill} />
        <circle cx="11.5" cy="14" r="2.6" fill={gemFill} />
        <circle cx="24" cy="8" r="3" fill={gemFill} />
        <circle cx="36.5" cy="14" r="2.6" fill={gemFill} />
        <path d="M16.5 31h15l3.5 5H13Zm-3.5 5h22l3 4v3H10v-3Z" fill={fill} />
        <path d="M17 27h14" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    rook: (
      <>
        <path d="M10 8h6v5h5V8h6v5h5V8h6v11l-5 4H15l-5-4Z" fill={fill} />
        <path d="M16 23h16l1 12H15Zm-1 12h18l4 4v4H11v-4Z" fill={fill} />
        <path d="M13 19h22m-17 12h12" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    bishop: (
      <>
        <path d="M24 10c3.8 3.1 10 9.1 10 14.5 0 4.5-3.5 7.5-10 7.5s-10-3-10-7.5c0-5.4 6.2-11.4 10-14.5Z" fill={fill} />
        <circle cx="24" cy="7.5" r="2.4" fill={gemFill} />
        <path d="M17 32h14l4 5H13Zm-4 5h22l2.5 3v3h-27v-3Z" fill={fill} />
        <path d="m27.5 15.5-6.5 9m-4 3.5h14" fill="none" stroke={ink.detail} strokeWidth="1.7" />
      </>
    ),
    knight: (
      <>
        <path d="M12.5 37c0-8 4-11 7.5-16l-6 3.5-5-2 3-7.5 7-5.5 1-5.5 5 4c8 0 13 7 13 16v13Z" fill={fill} />
        <path d="M13 37h24l2 3v3H10v-3Z" fill={fill} />
        <path d="M26 12c5 2 8 6 8 12m-5-9c-1 6-5.5 11-8 16" fill="none" stroke={ink.detail} strokeWidth="1.5" />
        <circle cx="19" cy="15" r="1.5" fill={ink.rim} stroke="none" />
      </>
    ),
    pawn: (
      <>
        <path d="M20 20h8c0 7 1.5 10.5 5.5 15.5h-19C18.5 30.5 20 27 20 20Z" fill={fill} />
        <path d="M15 35.5h18l3 4v3.5H12v-3.5Z" fill={fill} />
        <circle cx="24" cy="15" r="7.2" fill={fill} />
        <path d="M19 31.5h10" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    necromancer: (
      <>
        <path d="M7 38c2-7 5-11 8-16-1-6 1-12 9-17 6 4 9 10 8 17 3 6 5 10 6 16l2 4H6Z" fill={fill} />
        <path d="M16 20c1.4-4.7 4-7.6 8-10 4 3 6.3 6.2 6.5 10.5C30 25 27 28 24 30c-4-2.3-7.3-5.5-8-10Z" fill={ink.rim} stroke="none" />
        <path d="m19 21 2.5 1m5 0 2-1m-5 11-4 7m6-7 3.5 7" fill="none" stroke={ink.gem} strokeWidth="1.6" />
        <path d="M39 16v26" fill="none" strokeWidth="2.8" />
        <path d="m39 7 4.5 5-4.5 6-4.5-6Z" fill={gemFill} />
      </>
    ),
    dragon: (
      <>
        {/* 1. Back Layer: Spread 3-Scallop Bat Wing */}
        <path
          d="M21.8 25 C25.2 17.5, 32.5 11.5, 39.8 8.8 L41.5 6 L42 10 L45.6 15.5 Q40.8 18.5, 42.5 24.6 Q37.5 27, 37.5 32.5 Q33.5 33.8, 32 37 H22.8 Z"
          fill={wingFill}
        />
        <path
          d="M40 10 C37 16, 37.2 21, 42 24.2 M38.8 10.8 C34 18, 33 25, 37.2 32"
          fill="none"
          stroke={ink.detail}
          strokeWidth="1.35"
        />

        {/* 2. Foreground Layer: S-Curved Armored Neck, Wide Roaring Fanged Jaws & Twin Horns */}
        <path
          d="M12.2 37 C11 31.2, 13.4 27, 16.2 23.6 L8.2 23.8 L6.8 21.8 L9.5 21.4 L10.5 19.6 L11.8 21.3 L16.5 20.6 V16.2 L11.2 16 L9.8 18.2 L8.8 16 L5.2 15.6 L4.5 12.4 L10.8 10.6 L16 8.8 C19.4 5.4, 24.2 3.8, 29.8 3.6 C26.8 6.8, 24.6 8.8, 22.2 11 L28.8 10.2 C25.6 13, 23 14.6, 20.6 15.8 C22 21, 25.2 27.5, 26.2 37 Z"
          fill={fill}
        />

        {/* 3. Frameless Flame Breath Tongue & Fierce Eye */}
        <path
          d="M15.8 17.6 C11.2 16.9, 6.8 17.4, 2 18.6 C6.6 20.4, 11 20, 15.8 19.2 Z"
          fill={gemFill}
          stroke="none"
        />
        <path d="M12.8 12.5 L17.5 11.1 L15.8 13.8 Z" fill={ink.eye} stroke="none" />

        {/* 4. Chest Scales & 2-Tier Royal Pedestal Base */}
        <path
          d="M14.4 27.8 Q17.8 28.8, 20 27.4 M13.8 32 Q17.8 33, 20.6 31.6"
          fill="none"
          stroke={ink.detail}
          strokeWidth="1.35"
        />
        <path d="M11 37h23.5l2 2.8H9ZM9 39.8h27.5l1.5 3.2H7.5Z" fill={fill} />
      </>
    ),
    shielder: (
      <>
        <path d="M24 5c4.5 3 10 4.7 15 5.5V23c0 9-5.3 15-15 20-9.7-5-15-11-15-20V10.5C14 9.7 19.5 8 24 5Z" fill={fill} />
        <path d="M24 10c3.5 2 7.2 3.2 10.5 4v8.7c0 6.5-3.8 11-10.5 15-6.7-4-10.5-8.5-10.5-15V14c3.3-.8 7-2 10.5-4Z" fill="none" stroke={ink.detail} strokeWidth="1.5" />
        <path d="m24 15 5.3 8-5.3 8-5.3-8Z" fill={gemFill} />
        <path d="M24 17v12" fill="none" stroke={ink.rim} strokeWidth="1.2" />
      </>
    ),
  };
}

export function PieceGlyph({ type, color, className }: PieceGlyphProps) {
  const uid = useId().replace(/:/g, "");
  const gradId = `pg-${color}-${uid}`;
  const gemGradId = `pgg-${color}-${uid}`;
  const wingGradId = `pgw-${color}-${uid}`;
  const ink = palette[color];

  return (
    <svg
      aria-hidden="true"
      className={className ? `piece-glyph ${className}` : "piece-glyph"}
      focusable="false"
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      fill={ink.rim}
      stroke={ink.rim}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradId} x1="15%" y1="5%" x2="85%" y2="95%">
          <stop offset="0%" stopColor={ink.gradStart} />
          <stop offset="55%" stopColor={ink.gradMid} />
          <stop offset="100%" stopColor={ink.gradEnd} />
        </linearGradient>
        <linearGradient id={gemGradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fff3d6" />
          <stop offset="45%" stopColor={ink.gem} />
          <stop offset="100%" stopColor={ink.eye} />
        </linearGradient>
        <linearGradient id={wingGradId} x1="10%" y1="10%" x2="90%" y2="95%">
          <stop offset="0%" stopColor={ink.wingStart} />
          <stop offset="100%" stopColor={ink.wingEnd} />
        </linearGradient>
      </defs>
      {artwork(ink, gradId, gemGradId, wingGradId)[type]}
    </svg>
  );
}
