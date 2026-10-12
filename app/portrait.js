/**
 * Portraits: a face for every mind, drawn as SVG.
 *
 * A mind used to be an emoji in a circle. A portrait gives each one a look that
 * is its own and stays put: skin, hair, build and features are chosen from the
 * mind's id, so the same mind always looks the same, on every device, offline,
 * with no images to ship. Its colour sets the backdrop, its class sets the
 * badge, and its mood sets the expression, so a portrait also tells you how the
 * mind is doing without reading a word.
 *
 * Only numbers from fixed palettes and a validated colour ever reach the markup.
 */

const SKIN = ["#f1d3b8", "#e0b48f", "#c68a62", "#9a6440", "#6b4128"];
const HAIR = ["#1d1a22", "#4a3426", "#8c5a2b", "#d9b36a", "#c9c9d6", "#7a2e3a"];
/**
 * Hair comes in two layers: what sits behind the head (volume, length) and what
 * sits over the face (fringe, shading). Drawing a fringe behind the face would
 * hide it entirely.
 * @type {{ back: (c: string) => string, front: (c: string) => string }[]}
 */
const HAIR_STYLES = [
  // short crop: a cap above the head, a fringe line across the forehead
  { back: c => `<path d="M34 52 Q36 24 60 22 Q84 24 86 52 Q80 38 60 38 Q40 38 34 52Z" fill="${c}"/>`, front: () => "" },
  // long, falling past the shoulders
  { back: c => `<path d="M30 60 Q28 24 60 20 Q92 24 90 60 L94 92 Q76 84 72 74 L48 74 Q44 84 26 92Z" fill="${c}"/>`, front: () => "" },
  // bun over a sweep of fringe
  { back: c => `<circle cx="60" cy="22" r="10" fill="${c}"/>`, front: c => `<path d="M34 50 Q40 30 60 30 Q80 30 86 50 Q74 40 60 42 Q46 40 34 50Z" fill="${c}"/>` },
  // shaved, with shading where the hair would have been
  { back: () => "", front: () => `<path d="M38 46 Q60 30 82 46 Q76 40 60 40 Q44 40 38 46Z" fill="rgba(0,0,0,.18)"/>` }
];

const BADGE = {
  Scholar: "S", Warden: "W", Diplomat: "D", Maker: "M", Wanderer: "R", Mystic: "Y"
};

/**
 * FNV-1a: a small, stable hash, so a mind's looks depend only on its id.
 * @param {string} s
 */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** @param {string} c */
function safeColor(c) {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c)) ? String(c) : "#7d7d92";
}

/**
 * Read a mood word into one of four expressions.
 * @param {string} mood
 * @returns {"smile"|"flat"|"tired"|"stern"}
 */
export function expressionFor(mood) {
  const m = String(mood || "").toLowerCase();
  if (/angry|tense|bitter|wary|cold|sharp|restless|furious|guarded/.test(m)) return "stern";
  if (/tired|weary|sleep|low|sad|lonely|drained|hollow|numb/.test(m)) return "tired";
  if (/warm|happy|content|glad|bright|eager|calm|easy|buoyant|at ease|cheerful/.test(m)) return "smile";
  return "flat";
}

/**
 * @param {{ id: string, color: string, class?: string }} agent
 * @param {string} [mood]
 * @returns {string} An SVG document (a string, safe to set as innerHTML of a wrapper).
 */
export function portraitSvg(agent, mood = "") {
  const h = hash(String(agent.id));
  const pick = (/** @type {number} */ shift, /** @type {number} */ n) => ((h >>> shift) % n);
  const color = safeColor(agent.color);
  const skin = SKIN[pick(0, SKIN.length)];
  const hair = HAIR[pick(3, HAIR.length)];
  const style = HAIR_STYLES[pick(6, HAIR_STYLES.length)];
  const build = 46 + pick(9, 8);          // shoulder half-width
  const eyeGap = 14 + pick(12, 4);
  const brow = pick(15, 3) - 1;           // slight tilt, -1..1
  const expr = expressionFor(mood);
  // The class is free text for minds made by the keeper: keep only one safe character.
  const rawClass = String(agent.class || "");
  const badge = BADGE[/** @type {keyof typeof BADGE} */ (rawClass)]
    || (/^[A-Za-z0-9]$/.test(rawClass.charAt(0)) ? rawClass.charAt(0).toUpperCase() : "?");
  const bg = `g${h.toString(36)}`; // full hash: portraits share a page, so ids must not collide

  const eyeY = 58;
  const eyeLid = expr === "tired" ? 3 : 0; // lids drop when tired
  const browY = expr === "stern" ? 47 : 49;
  const browTilt = expr === "stern" ? 3 : brow;
  const mouth =
    expr === "smile" ? `M50 78 Q60 86 70 78`
    : expr === "stern" ? `M52 80 L68 80`
    : expr === "tired" ? `M52 81 Q60 78 68 81`
    : `M52 80 Q60 81 68 80`;

  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${badge} portrait">
  <defs>
    <radialGradient id="${bg}" cx="50%" cy="35%" r="75%">
      <stop offset="0" stop-color="${color}" stop-opacity=".95"/>
      <stop offset="1" stop-color="#0b0b12"/>
    </radialGradient>
  </defs>
  <rect width="120" height="120" fill="url(#${bg})"/>
  <path d="M${60 - build} 120 Q${60 - build} 92 60 90 Q${60 + build} 92 ${60 + build} 120Z" fill="${color}" opacity=".85"/>
  <rect x="53" y="76" width="14" height="18" rx="5" fill="${skin}"/>
  ${style.back(hair)}
  <ellipse cx="60" cy="56" rx="22" ry="25" fill="${skin}"/>
  ${style.front(hair)}
  <path d="M${60 - eyeGap - 5} ${browY + browTilt} L${60 - eyeGap + 5} ${browY - browTilt}" stroke="#1d1a22" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M${60 + eyeGap - 5} ${browY - browTilt} L${60 + eyeGap + 5} ${browY + browTilt}" stroke="#1d1a22" stroke-width="2.4" stroke-linecap="round"/>
  <ellipse cx="${60 - eyeGap}" cy="${eyeY}" rx="4" ry="${4 - eyeLid / 2}" fill="#1d1a22"/>
  <ellipse cx="${60 + eyeGap}" cy="${eyeY}" rx="4" ry="${4 - eyeLid / 2}" fill="#1d1a22"/>
  ${eyeLid ? `<path d="M${60 - eyeGap - 4} ${eyeY - 1} L${60 - eyeGap + 4} ${eyeY - 1} M${60 + eyeGap - 4} ${eyeY - 1} L${60 + eyeGap + 4} ${eyeY - 1}" stroke="${skin}" stroke-width="3"/>` : ""}
  <path d="${mouth}" fill="none" stroke="#5a2d2d" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="98" cy="98" r="13" fill="#0b0b12" stroke="${color}" stroke-width="2.5"/>
  <text x="98" y="103" text-anchor="middle" font-family="Georgia, serif" font-size="14" font-weight="700" fill="${color}">${badge}</text>
</svg>`;
}
