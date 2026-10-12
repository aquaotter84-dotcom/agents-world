/**
 * "While you were away."
 *
 * The headless runner keeps the world ticking when the keeper closes the app,
 * and the app pays back closed time by running the same simulation forward. Both
 * of those are the same world moving without a witness — and a world that moves
 * without a witness needs to account for itself when one comes back, or absence
 * has no texture at all.
 *
 * So: a digest, built by *comparing two states of the same world*. Nothing here
 * invents colour. Every line is a real difference — a memorial that did not
 * exist before, a rule that was just enacted, meters that moved, the biggest
 * event in the window — and if nothing changed, the digest says that instead.
 *
 * The comparison happens across a `digestMark`: a small, plain record of the
 * facts worth noticing, taken before the keeper leaves. That matters because the
 * world after the absence is the only world left — the app cannot hold two live
 * simulations in memory, and it should not need to.
 *
 * Everything here is pure: no DOM, no storage, no clock of its own. The wall
 * clock is passed in, because "eight hours" is the keeper's time, not the
 * world's, and the engine's clock has no idea when the app was closed.
 */

import { WANT_METERS, WANT_LABELS } from "./vendor/engine/model/want.js";

/**
 * @typedef {object} DigestMark
 * @property {number} tick
 * @property {number} day
 * @property {number} topSeq
 * @property {{agentId: string, name: string, kind: string, day: number, text: string, inherited: {heir: string, about: string}[]}[]} memorials
 * @property {{name: string, regionId: string, day: number, mourners: number}[]} held
 * @property {number} openFunerals
 * @property {string[]} rules
 * @property {{name: string, holder: string}[]} roles
 * @property {number} wall
 * @property {boolean} wallRaised
 * @property {Record<string, number>} want
 * @property {number} quietSince
 * @property {boolean} fallen
 * @property {number} asks
 * @property {number} ignored
 * @property {number} rivalries
 * @property {number} vendettas
 * @property {number} secrets
 * @property {number} publicSecrets
 * @property {number} asksWaiting
 */

/**
 * Everything worth noticing about a world, in a shape small enough to keep for
 * however long the keeper is gone.
 * @param {import("./vendor/engine/model/world.js").World} world
 * @returns {DigestMark}
 */
export function digestMark(world) {
  const nameOf = (/** @type {string|null} */ id) =>
    (id && world.agents.find((/** @type {any} */ a) => a.id === id)?.name) || "someone";
  const mourning = world.mourning || { funerals: [], memorials: [] };
  const charter = world.charter || { rules: [], roles: [], petitions: [], dilemmas: [], whispers: [] };
  const project = world.project || { progress: 0, status: "active" };
  const agents = world.agents || [];
  const edgeCounts = { rivalries: 0, vendettas: 0 };
  for (const agent of agents) {
    if (agent.retired) continue;
    for (const [otherId, edge] of Object.entries(agent.relations || {})) {
      const other = agents.find((/** @type {any} */ a) => a.id === otherId);
      if (!other || other.retired || agent.id > otherId) continue;
      const heat = Math.max(edge.resentment, other.relations[agent.id]?.resentment ?? 0);
      if (heat >= 60) edgeCounts.vendettas += 1;
      else if (heat >= 35) edgeCounts.rivalries += 1;
    }
  }
  return {
    tick: world.clock.tick,
    day: world.clock.day,
    topSeq: world.events.length ? world.events[0].seq : 0,
    memorials: (mourning.memorials || []).map(/** @param {any} m */ m => ({
      agentId: m.agentId,
      name: m.name,
      kind: m.kind,
      day: m.day,
      text: m.text,
      inherited: (m.inherited || []).map(/** @param {any} i */ i => ({
        heir: nameOf(i.heirId),
        about: nameOf(i.aboutId)
      }))
    })),
    held: (mourning.funerals || []).filter(/** @param {any} f */ f => f.held)
      .map(/** @param {any} f */ f => ({ name: f.name, regionId: f.regionId, day: Math.floor((f.heldTick ?? 0) / 48) + 1, mourners: (f.mourners || []).length })),
    openFunerals: (mourning.funerals || []).filter(/** @param {any} f */ f => !f.held).length,
    rules: (charter.rules || []).filter(/** @param {any} r */ r => r.ruling === "enacted").map(/** @param {any} r */ r => r.ruleKind),
    roles: (charter.roles || []).map(/** @param {any} r */ r => ({ name: r.name, holder: nameOf(r.holderId) })),
    wall: Math.round((project.progress || 0) * 10) / 10,
    wallRaised: Boolean(project.status === "complete" || charter.wallRaised),
    want: {
      harmony: world.want?.harmony ?? 0,
      prosperity: world.want?.prosperity ?? 0,
      legacy: world.want?.legacy ?? 0
    },
    quietSince: world.want?.quietTicks ?? 0,
    fallen: Boolean(world.want?.fallen),
    asks: world.want?.asks ?? 0,
    ignored: world.want?.ignored ?? 0,
    rivalries: edgeCounts.rivalries,
    vendettas: edgeCounts.vendettas,
    secrets: (world.secrets || []).length,
    publicSecrets: (world.secrets || []).filter(/** @param {any} s */ s => s.isPublic).length,
    asksWaiting: (charter.petitions || []).filter(/** @param {any} p */ p => p.status === "open").length +
      (charter.dilemmas || []).filter(/** @param {any} d */ d => d.status === "open").length +
      (charter.whispers || []).filter(/** @param {any} w */ w => !w.actedOn).length
  };
}

/**
 * What happened between two states of the same world.
 *
 * @param {DigestMark} mark   The world when the keeper left.
 * @param {import("./vendor/engine/model/world.js").World} world  The world now.
 * @param {{hours?: number|null, because?: "service"|"offline"|"manual"}} [meta]
 * @returns {{ticks: number, days: number, hours: number|null, because: string, lines: {kind: string, text: string}[], meters: {key: string, label: string, color: string, from: number, to: number, delta: number}[], quiet: {since: number, fallen: boolean}, headline: {text: string, kind: string, tick: number}|null, empty: boolean}}
 */
export function awayDigest(mark, world, meta = {}) {
  const now = digestMark(world);
  const ticks = Math.max(0, now.tick - mark.tick);
  const days = Math.max(0, now.day - mark.day);
  const hours = typeof meta.hours === "number" && Number.isFinite(meta.hours) ? meta.hours : null;
  const because = meta.because || "manual";
  /** @type {{kind: string, text: string}[]} */
  const lines = [];

  if (ticks > 0) {
    const span = days > 0
      ? `${days} world day${days === 1 ? "" : "s"} (${ticks} ticks)`
      : `${ticks} tick${ticks === 1 ? "" : "s"}`;
    const real = hours !== null && hours >= 1
      ? ` — about ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} of your time`
      : "";
    lines.push({ kind: "span", text: `The world kept going for ${span}${real}.` });
  }

  // The dead first: what the world lost outranks what it built.
  const known = new Set(mark.memorials.map(m => m.agentId));
  for (const memorial of now.memorials.filter(m => !known.has(m.agentId))) {
    lines.push({ kind: "death", text: memorial.text });
    for (const inherited of memorial.inherited) {
      lines.push({
        kind: "inherited",
        text: `What ${memorial.name} had against ${inherited.about} did not die with them — it is ${inherited.heir}'s now.`
      });
    }
  }

  // Gatherings that were still coming when the keeper left, and have now been held.
  const heldBefore = new Set(mark.held.map(f => f.name + "|" + f.day));
  for (const funeral of now.held) {
    if (heldBefore.has(funeral.name + "|" + funeral.day)) continue;
    const region = (world.regions || []).find((/** @type {any} */ r) => r.id === funeral.regionId);
    lines.push({
      kind: "gathering",
      text: `The world gathered for ${funeral.name} at ${region ? region.name : "the grave"}, and ${funeral.mourners} of them came.`
    });
  }

  // The shared work.
  if (now.wallRaised && !mark.wallRaised) {
    lines.push({ kind: "wall", text: "The North Wall stands. Every mind here is safer for work they did together." });
  } else if (!now.wallRaised && now.wall > mark.wall) {
    lines.push({ kind: "wall", text: `The wall went from ${Math.round(mark.wall)}% to ${Math.round(now.wall)}%.` });
  } else if (!now.wallRaised && now.wall < mark.wall) {
    lines.push({ kind: "wall", text: `The wall lost ground while you were gone: ${Math.round(mark.wall)}% to ${Math.round(now.wall)}%.` });
  }

  // What the world decided about how it lives.
  const newRules = now.rules.filter(rule => !mark.rules.includes(rule));
  if (newRules.length) {
    lines.push({ kind: "law", text: `New customs were made without you: ${newRules.join(", ")}.` });
  }
  const heldRoles = new Set(mark.roles.map(role => role.name + "|" + role.holder));
  for (const role of now.roles) {
    if (!heldRoles.has(role.name + "|" + role.holder)) {
      lines.push({ kind: "role", text: `The world started calling ${role.holder} ${role.name}.` });
    }
  }

  // Quarrels, which are the world's weather.
  if (now.vendettas > mark.vendettas) {
    const gained = now.vendettas - mark.vendettas;
    lines.push({ kind: "feud", text: `${gained} quarrel${gained === 1 ? "" : "s"} went all the way to vendetta.` });
  } else if (now.rivalries > mark.rivalries) {
    const gained = now.rivalries - mark.rivalries;
    lines.push({ kind: "feud", text: `${gained} new grudge${gained === 1 ? "" : "s"} hardened into a rivalry.` });
  }

  // The keeper's own ledger: what was asked, and what was never answered.
  const asksDelta = Math.max(0, now.asks - mark.asks);
  const ignoredDelta = Math.max(0, now.ignored - mark.ignored);
  if (asksDelta > 0) {
    lines.push({
      kind: "asks",
      text: `${asksDelta} thing${asksDelta === 1 ? "" : "s"} asked for you while you were away` +
        (ignoredDelta > 0 ? `, and ${ignoredDelta} of them went unanswered` : "") + "."
    });
  } else if (ignoredDelta > 0) {
    lines.push({
      kind: "asks",
      text: `${ignoredDelta} ask${ignoredDelta === 1 ? "" : "s"} went unanswered while you were away — nobody was there to rule on them.`
    });
  } else if (ticks > 48) {
    lines.push({ kind: "asks", text: "Nothing asked you for anything at all." });
  }

  // The lose condition, said plainly.
  if (now.fallen && !mark.fallen) {
    lines.push({
      kind: "quiet",
      text: "The world went quiet while you were gone. It still runs, but nothing is asked of you any more, and the harmony that held it together is spent."
    });
  } else if (now.quietSince > 0 && now.quietSince > mark.quietSince) {
    const quietDays = Math.floor(now.quietSince / 48);
    lines.push({
      kind: "quiet",
      text: `Nothing has asked you for anything in ${quietDays} day${quietDays === 1 ? "" : "s"} — harmony is draining.`
    });
  }

  const secretsDelta = Math.max(0, now.secrets - mark.secrets);
  if (secretsDelta > 0) {
    lines.push({ kind: "secret", text: `${secretsDelta} new secret${secretsDelta === 1 ? "" : "s"} started circulating.` });
  }
  if (now.asksWaiting > mark.asksWaiting) {
    lines.push({
      kind: "waiting",
      text: `${now.asksWaiting} thing${now.asksWaiting === 1 ? " is" : "s are"} waiting on you now.`
    });
  }

  // The single biggest thing that happened, in the world's own words.
  let headline = null;
  if (ticks > 0) {
    for (const event of world.events) {
      if (event.tick <= mark.tick) break;
      if ((event.significance || 0) < 0.5) continue;
      if (!headline || (event.significance || 0) > (headline.significance || 0)) headline = event;
    }
  }

  const meters = WANT_METERS.map(key => ({
    key,
    label: WANT_LABELS[key].name,
    color: WANT_LABELS[key].color,
    from: Math.round((mark.want[key] ?? 0) * 10) / 10,
    to: Math.round(now.want[key] ?? 0),
    delta: Math.round(((now.want[key] ?? 0) - (mark.want[key] ?? 0)) * 10) / 10
  }));

  return {
    ticks,
    days,
    hours,
    because,
    lines,
    meters,
    quiet: { since: now.quietSince, fallen: now.fallen },
    headline: headline ? { text: headline.text, kind: headline.kind, tick: headline.tick } : null,
    empty: lines.length === 0 && meters.every(m => Math.abs(m.delta) < 0.05)
  };
}

/**
 * The digest in one sentence, for a toast.
 * @param {ReturnType<typeof awayDigest>} digest
 */
export function digestLine(digest) {
  if (digest.empty || digest.ticks === 0) return "The world is where you left it.";
  const span = digest.days > 0
    ? `${digest.days} day${digest.days === 1 ? "" : "s"}`
    : `${digest.ticks} tick${digest.ticks === 1 ? "" : "s"}`;
  const headline = digest.headline ? ` ${digest.headline.text}` : "";
  const first = digest.lines.find(l => l.kind !== "span" && l.kind !== "asks");
  return `While you were away the world kept going for ${span}.${headline || (first ? " " + first.text : "")} The Chronicle has the rest.`;
}
