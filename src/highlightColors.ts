/**
 * The 20 highlight colors offered from the app menu (View → Highlight Color).
 * Each is just an accent hex — everything that reads `--accent` (borders,
 * active tabs, focus rings, the editor's keyword color) follows whichever one
 * is picked. `pink` is the default, matched to macOS's own Pink highlight
 * color so the app doesn't clash with text selection elsewhere on the system.
 */
export type HighlightColor = {
  id: string;
  label: string;
  hex: string;
};

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { id: 'pink', label: 'Pink', hex: '#ffbfd2' },
  { id: 'red', label: 'Red', hex: '#ff6b6b' },
  { id: 'coral', label: 'Coral', hex: '#ff8f70' },
  { id: 'orange', label: 'Orange', hex: '#f0a857' },
  { id: 'amber', label: 'Amber', hex: '#f0c674' },
  { id: 'yellow', label: 'Yellow', hex: '#e8d16a' },
  { id: 'lime', label: 'Lime', hex: '#b5d96a' },
  { id: 'green', label: 'Green', hex: '#8fd67a' },
  { id: 'mint', label: 'Mint', hex: '#7fd9b0' },
  { id: 'teal', label: 'Teal', hex: '#6fc7c0' },
  { id: 'cyan', label: 'Cyan', hex: '#6fc9e0' },
  { id: 'sky', label: 'Sky', hex: '#7fb8f0' },
  { id: 'blue', label: 'Blue', hex: '#7f9ff0' },
  { id: 'indigo', label: 'Indigo', hex: '#8f8fe0' },
  { id: 'lavender', label: 'Lavender', hex: '#c58fe0' },
  { id: 'purple', label: 'Purple', hex: '#b46fe0' },
  { id: 'violet', label: 'Violet', hex: '#a05fe8' },
  { id: 'magenta', label: 'Magenta', hex: '#e070c8' },
  { id: 'rose', label: 'Rose', hex: '#e88fa8' },
  { id: 'graphite', label: 'Graphite', hex: '#a3abbf' },
];

export const DEFAULT_HIGHLIGHT_COLOR = 'pink';

export function isHighlightColorId(id: unknown): id is string {
  return typeof id === 'string' && HIGHLIGHT_COLORS.some((c) => c.id === id);
}

export function highlightColorHex(id: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.id === id)?.hex ?? HIGHLIGHT_COLORS[0].hex;
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, n));
}

/**
 * A dimmer companion shade for secondary accent text and borders. Pulls every
 * channel part-way toward the app background rather than rotating hue, so it
 * works the same way for any of the 20 colors above.
 */
export function softVariant(hex: string): string {
  const bg = { r: 0x16, g: 0x18, b: 0x1f };
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const toward = (c: number, bgc: number) => clamp255(Math.round(c * 0.82 + bgc * 0.18));
  const rr = toward(r, bg.r).toString(16).padStart(2, '0');
  const gg = toward(g, bg.g).toString(16).padStart(2, '0');
  const bb = toward(b, bg.b).toString(16).padStart(2, '0');
  return `#${rr}${gg}${bb}`;
}
