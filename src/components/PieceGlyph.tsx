import type { ReactNode } from "react";
import type { Color, PieceType } from "../engine/model";

interface PieceGlyphProps {
  type: PieceType;
  color: Color;
  className?: string;
}

interface Ink {
  body: string;
  rim: string;
  detail: string;
  gem: string;
}

const palette: Record<Color, Ink> = {
  white: { body: "#fff1d5", rim: "#492b3b", detail: "#8d4d66", gem: "#c86580" },
  black: { body: "#382a38", rim: "#f4d2ba", detail: "#d492a3", gem: "#f09aaf" },
};

function artwork(ink: Ink): Record<PieceType, ReactNode> {
  return {
    king: (
      <>
        <path d="M24 3v11m-5.5-6h11" strokeWidth="2.6" />
        <path d="M17 31c-2-5-7-7-7-12 0-4 3-7 7-7 3 0 5 1 7 4 2-3 4-4 7-4 4 0 7 3 7 7 0 5-5 7-7 12Z" />
        <path d="M17 31h14l3.5 5H13.5ZM13.5 36h21l3 4v3h-27v-3Z" />
        <path d="M24 16v11m-7 1h14" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    queen: (
      <>
        <path d="m12 15 6.5 6L24 9l5.5 12 6.5-6-4.5 16h-15Z" />
        <circle cx="11.5" cy="14" r="2.6" />
        <circle cx="24" cy="8" r="3" />
        <circle cx="36.5" cy="14" r="2.6" />
        <path d="M16.5 31h15l3.5 5H13Zm-3.5 5h22l3 4v3H10v-3Z" />
        <path d="M17 27h14" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    rook: (
      <>
        <path d="M10 8h6v5h5V8h6v5h5V8h6v11l-5 4H15l-5-4Z" />
        <path d="M16 23h16l1 12H15Zm-1 12h18l4 4v4H11v-4Z" />
        <path d="M13 19h22m-17 12h12" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    bishop: (
      <>
        <path d="M24 10c3.8 3.1 10 9.1 10 14.5 0 4.5-3.5 7.5-10 7.5s-10-3-10-7.5c0-5.4 6.2-11.4 10-14.5Z" />
        <circle cx="24" cy="7.5" r="2.4" />
        <path d="M17 32h14l4 5H13Zm-4 5h22l2.5 3v3h-27v-3Z" />
        <path d="m27.5 15.5-6.5 9m-4 3.5h14" fill="none" stroke={ink.detail} strokeWidth="1.7" />
      </>
    ),
    knight: (
      <>
        <path d="M12.5 37c0-8 4-11 7.5-16l-6 3.5-5-2 3-7.5 7-5.5 1-5.5 5 4c8 0 13 7 13 16v13Z" />
        <path d="M13 37h24l2 3v3H10v-3Z" />
        <path d="M26 12c5 2 8 6 8 12m-5-9c-1 6-5.5 11-8 16" fill="none" stroke={ink.detail} strokeWidth="1.5" />
        <circle cx="19" cy="15" r="1.5" fill={ink.rim} stroke="none" />
      </>
    ),
    pawn: (
      <>
        <path d="M20 20h8c0 7 1.5 10.5 5.5 15.5h-19C18.5 30.5 20 27 20 20Z" />
        <path d="M15 35.5h18l3 4v3.5H12v-3.5Z" />
        <circle cx="24" cy="15" r="7.2" />
        <path d="M19 31.5h10" fill="none" stroke={ink.detail} strokeWidth="1.4" />
      </>
    ),
    necromancer: (
      <>
        <path d="M7 38c2-7 5-11 8-16-1-6 1-12 9-17 6 4 9 10 8 17 3 6 5 10 6 16l2 4H6Z" />
        <path d="M16 20c1.4-4.7 4-7.6 8-10 4 3 6.3 6.2 6.5 10.5C30 25 27 28 24 30c-4-2.3-7.3-5.5-8-10Z" fill={ink.rim} stroke="none" />
        <path d="m19 21 2.5 1m5 0 2-1m-5 11-4 7m6-7 3.5 7" fill="none" stroke={ink.gem} strokeWidth="1.6" />
        <path d="M39 16v26" fill="none" strokeWidth="2.8" />
        <path d="m39 7 4.5 5-4.5 6-4.5-6Z" fill={ink.gem} />
      </>
    ),
    dragon: (
      <>
        <path d="M11 39c.8-7 5-11 10-14-3 1-8 1-12-2L5 19l5-4 7-.5 3-4-2-6 7 4 5-4 1 7c7 4 10 10 9 17l3 9-5-2 1 5Z" />
        <path d="M11 39h27l3 4H8Z" />
        <path d="M23 28c3-1.3 5-1.4 8-.3l-1.5 5 5-2.1m-25-11 7 .2m14-5.5c2 1.9 3.3 4 3.7 6" fill="none" stroke={ink.detail} strokeWidth="1.5" />
        <path d="m22 15 5 .6-3 2.1Z" fill={ink.gem} strokeWidth="1.2" />
        <path d="m13 22 2 2 1.5-2" fill="none" strokeWidth="1.1" />
      </>
    ),
    shielder: (
      <>
        <path d="M24 5c4.5 3 10 4.7 15 5.5V23c0 9-5.3 15-15 20-9.7-5-15-11-15-20V10.5C14 9.7 19.5 8 24 5Z" />
        <path d="M24 10c3.5 2 7.2 3.2 10.5 4v8.7c0 6.5-3.8 11-10.5 15-6.7-4-10.5-8.5-10.5-15V14c3.3-.8 7-2 10.5-4Z" fill="none" stroke={ink.detail} strokeWidth="1.5" />
        <path d="m24 15 5.3 8-5.3 8-5.3-8Z" fill={ink.gem} />
        <path d="M24 17v12" fill="none" stroke={ink.rim} strokeWidth="1.2" />
      </>
    ),
  };
}

const icons = { white: artwork(palette.white), black: artwork(palette.black) };

export function PieceGlyph({ type, color, className }: PieceGlyphProps) {
  const ink = palette[color];

  return (
    <svg
      aria-hidden="true"
      className={className ? `piece-glyph ${className}` : "piece-glyph"}
      focusable="false"
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      fill={ink.body}
      stroke={ink.rim}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      xmlns="http://www.w3.org/2000/svg"
    >
      {icons[color][type]}
    </svg>
  );
}