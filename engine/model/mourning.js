/**
 * Mourning: what the world keeps of the minds it has lost.
 *
 * Two things live here, and they are different.
 *
 *   A *funeral* is an event still coming. The world hears that someone is gone
 *   and gathers — a little later, at a place, with the minds who knew them
 *   best actually moving there. Until it is held, it carries who is expected
 *   and where; after, it carries who came and what passed on.
 *
 *   A *memorial* is what stays. One entry per mind the world has lost, whether
 *   they were buried or simply walked out of the story. It is the mourning
 *   chronicle: the record of what is gone, of who stood at the grave, and of
 *   the quarrels that did not die with the person holding them.
 *
 * Nothing here is authored in advance and nothing here is flavour: a memorial
 * is read by the legacy meter, by the board, and by the record, so a death
 * cannot be invisible.
 */

/** How many funerals the world remembers (recent ones only). */
export const FUNERAL_CAP = 24;
/** How many memorials the world keeps. */
export const MEMORIAL_CAP = 64;

/**
 * @typedef {object} Funeral
 * @property {string} id
 * @property {string} agentId        The mind being buried.
 * @property {string} name
 * @property {string} epithet
 * @property {string} className
 * @property {number} level
 * @property {string} regionId       Where the world gathers.
 * @property {number} calledTick
 * @property {number} holdTick       When the gathering happens.
 * @property {boolean} held
 * @property {number} [heldTick]
 * @property {string[]} mourners     Who came, by id (filled when held).
 * @property {string[]} heirs        Who took up the dead's quarrels.
 * @property {{heirId: string, aboutId: string}[]} inherited
 * @property {string} deeds          One line of what they did while they were here.
 */

/**
 * @typedef {object} Memorial
 * @property {string} id
 * @property {string} agentId
 * @property {string} name
 * @property {string} epithet
 * @property {"death"|"departure"} kind   Buried, or gone from the map.
 * @property {string} regionId
 * @property {number} tick
 * @property {number} day
 * @property {string[]} mourners
 * @property {string[]} heirs
 * @property {{heirId: string, aboutId: string}[]} inherited
 * @property {string} text           What the world keeps of them, in one line.
 * @property {string} deeds          What they did while they were here, in one line.
 */

/**
 * The world's mourning, as it lives on the save.
 * @typedef {object} Mourning
 * @property {Funeral[]} funerals
 * @property {Memorial[]} memorials
 */

/** @returns {Mourning} */
export function createMourning() {
  return { funerals: [], memorials: [] };
}

/**
 * Coerce whatever came out of a save into valid mourning. An old world has
 * simply lost no one yet, which is the honest answer.
 * @param {unknown} raw
 * @returns {Mourning}
 */
export function normalizeMourning(raw) {
  const base = createMourning();
  const m = /** @type {any} */ (raw);
  if (!m || typeof m !== "object") return base;
  /** @param {unknown} value */
  const list = value => (Array.isArray(value) ? value.filter(x => x && typeof x === "object") : []);
  return {
    funerals: list(m.funerals).slice(-FUNERAL_CAP),
    memorials: list(m.memorials).slice(-MEMORIAL_CAP)
  };
}

/**
 * Funerals the world has been told about and has not held yet.
 * @param {Mourning} mourning
 */
export function pendingFunerals(mourning) {
  return mourning.funerals.filter(f => !f.held);
}

/**
 * The memorials for minds the world buried, newest first.
 * @param {Mourning} mourning
 * @param {number} [n]
 */
export function buriedMemorials(mourning, n = 8) {
  return mourning.memorials.filter(m => m.kind === "death").slice(-n).reverse();
}

/**
 * The memorials the world keeps of every mind it has lost, newest first.
 * @param {Mourning} mourning
 * @param {number} [n]
 */
export function recentMemorials(mourning, n = 8) {
  return mourning.memorials.slice(-n).reverse();
}

/**
 * The funeral for a mind, held or not, if one was called.
 * @param {Mourning} mourning
 * @param {string} agentId
 * @returns {Funeral|null}
 */
export function funeralFor(mourning, agentId) {
  for (let i = mourning.funerals.length - 1; i >= 0; i--) {
    if (mourning.funerals[i].agentId === agentId) return mourning.funerals[i];
  }
  return null;
}

/**
 * The memorial for a mind, if the world keeps one.
 * @param {Mourning} mourning
 * @param {string} agentId
 * @returns {Memorial|null}
 */
export function memorialFor(mourning, agentId) {
  for (let i = mourning.memorials.length - 1; i >= 0; i--) {
    if (mourning.memorials[i].agentId === agentId) return mourning.memorials[i];
  }
  return null;
}

/** Push a funeral, capped. @param {Mourning} mourning @param {Funeral} funeral */
export function recordFuneral(mourning, funeral) {
  mourning.funerals.push(funeral);
  if (mourning.funerals.length > FUNERAL_CAP) {
    mourning.funerals.splice(0, mourning.funerals.length - FUNERAL_CAP);
  }
  return funeral;
}

/** Push a memorial, capped. @param {Mourning} mourning @param {Memorial} memorial */
export function recordMemorial(mourning, memorial) {
  mourning.memorials.push(memorial);
  if (mourning.memorials.length > MEMORIAL_CAP) {
    mourning.memorials.splice(0, mourning.memorials.length - MEMORIAL_CAP);
  }
  return memorial;
}
