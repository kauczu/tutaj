// Quick reactions: an emoji that floats up over the sender's tile for everyone (and in the game overlay).

export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'] as const;
export type Reaction = (typeof REACTIONS)[number];

export const isReaction = (v: unknown): v is Reaction => (REACTIONS as readonly unknown[]).includes(v);

const FLOAT_MS = 2600;

/** CSS for the floating emoji (also injected into the overlay window's document). */
export const REACTION_CSS = `
.reaction { position: absolute; bottom: 8%; z-index: 3; pointer-events: none; font-size: clamp(28px, 18%, 64px);
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6)); animation: reaction-float ${FLOAT_MS}ms ease-out forwards; }
@keyframes reaction-float {
  0% { transform: translateY(0) scale(0.6); opacity: 0; }
  12% { transform: translateY(-8%) scale(1.15); opacity: 1; }
  70% { opacity: 1; }
  100% { transform: translateY(-260%) scale(1); opacity: 0; }
}`;

/** Lets `emoji` float up over `container` (a tile), at a slightly random horizontal spot. */
export function floatReaction(container: HTMLElement, emoji: string): void {
  const el = container.ownerDocument.createElement('span');
  el.className = 'reaction';
  el.textContent = emoji;
  el.style.left = `${15 + Math.random() * 60}%`;
  container.append(el);
  setTimeout(() => el.remove(), FLOAT_MS);
}
