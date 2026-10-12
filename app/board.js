/**
 * What the atlas shows, decided without a canvas.
 *
 * The map is a board, and a board has to answer questions: who is waiting on
 * the keeper, how bad is this feud, is that mind building or breaking, which
 * people are tied together by something not yet said. Those answers are facts
 * about the world, so they live here — pure, readable from a test, and with no
 * pixel arithmetic mixed in. The canvas code in `app.js` only positions and
 * paints what this module reports.
 *
 * Nothing in here writes to the world. A render path must never mutate the
 * simulation, and at sixty frames a second that rule needs to be structural
 * rather than a matter of care.
 */

import { feudStage } from "./vendor/engine/index.js";

/**
 * @typedef {import("./vendor/engine/model/world.js").World} World
 * @typedef {import("./vendor/engine/model/agent.js").Agent} Agent
 */

/**
 * The marks the board puts down for what is waiting on the keeper.
 *
 * Each carries the mind it belongs to and the region it should be drawn over,
 * so the canvas can place it without knowing anything about the charter.
 *
 * @param {World} world
 * @returns {{kind: "petition"|"whisper"|"dilemma", id: string, agentId: string|null, subjectId: string|null, regionId: string|null, shape: string, label: string}[]}
 */
export function boardSigils(world) {
  const charter = world.charter;
  if (!charter) return [];
  const regionOf = (/** @type {string|null} */ id) => {
    if (!id) return null;
    const agent = world.agents.find((/** @type {any} */ a) => a.id === id);
    return agent ? agent.regionId : null;
  };

  /** @type {ReturnType<typeof boardSigils>} */
  const out = [];
  for (const petition of charter.petitions) {
    if (petition.status !== "open") continue;
    out.push({
      kind: "petition",
      id: petition.id,
      agentId: petition.agentId,
      subjectId: null,
      regionId: regionOf(petition.agentId),
      // A scroll for a tradition, a seal for a law: two shapes, no legend.
      shape: petition.kind === "law" ? "seal" : "scroll",
      label: petition.kind === "law" ? "law" : "tradition"
    });
  }
  for (const whisper of charter.whispers) {
    if (whisper.actedOn) continue;
    out.push({
      kind: "whisper",
      id: whisper.id,
      agentId: whisper.agentId,
      subjectId: whisper.aboutId,
      regionId: regionOf(whisper.agentId),
      shape: "star",
      label: "whisper"
    });
  }
  for (const dilemma of charter.dilemmas) {
    if (dilemma.status !== "open") continue;
    const first = dilemma.partyIds[0] ?? null;
    out.push({
      kind: "dilemma",
      id: dilemma.id,
      agentId: first,
      subjectId: dilemma.partyIds[1] ?? null,
      regionId: regionOf(first),
      shape: "warning",
      label: dilemma.kind
    });
  }
  return out;
}

/**
 * How a mind reads at a glance.
 *
 * A builder gets a spark, a saboteur gets a red flicker — and the two are read
 * off the same project ledger the engine writes, so the glyph cannot disagree
 * with what actually happened. A mind that has done neither gets nothing.
 *
 * @param {World} world
 * @param {Agent} agent
 * @returns {"builder"|"saboteur"|null}
 */
export function mindGlyph(world, agent) {
  const record = world.project && world.project.contributors[agent.id];
  if (!record) return null;
  // Sabotage reads first: a mind that has both built and broken is showing you
  // the part that matters.
  if (record.interference > 0) return "saboteur";
  if (record.work > 0 || record.help > 0) return "builder";
  return null;
}

/**
 * The feuds worth drawing, with the stage that makes them different weathers.
 * @param {World} world
 * @returns {{a: string, b: string, stage: "rivalry"|"vendetta", heat: number}[]}
 */
export function feudArcs(world) {
  const living = world.agents.filter((/** @type {any} */ a) => !a.retired);
  /** @type {ReturnType<typeof feudArcs>} */
  const out = [];
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const A = living[i], B = living[j];
      const ea = A.relations[B.id], eb = B.relations[A.id];
      if (!ea || !eb) continue;
      const stage = feudStage(ea, eb, world.config);
      if (stage !== "rivalry" && stage !== "vendetta") continue;
      out.push({
        a: A.id,
        b: B.id,
        stage,
        heat: Math.max(ea.resentment, eb.resentment)
      });
    }
  }
  return out.sort((x, y) => y.heat - x.heat);
}

/**
 * Threads as constellations: a secret still being kept by more than one mind is
 * a shape on the board, and tapping it opens that thread rather than a dossier.
 * @param {World} world
 * @returns {{secretId: string, holders: string[]}[]}
 */
export function constellations(world) {
  /** @type {ReturnType<typeof constellations>} */
  const out = [];
  for (const secret of world.secrets) {
    if (secret.isPublic) continue;
    const holders = Object.keys(secret.holders).filter(id => world.agents.some((/** @type {any} */ a) => a.id === id && !a.retired));
    if (holders.length < 2) continue;
    out.push({ secretId: secret.id, holders });
  }
  return out;
}

/**
 * The wall's palette, as a single 0..1 amount of warmth plus whether it is done.
 * The shared work is the board's headline, so the region itself changes colour
 * as it goes up rather than carrying a number over an unchanged picture.
 * @param {World} world
 * @returns {{k: number, complete: boolean, progress: number}}
 */
export function projectPalette(world) {
  const project = world.project;
  const complete = Boolean(project && project.status === "complete");
  const progress = project ? project.progress : 0;
  return { k: complete ? 1 : Math.max(0, Math.min(1, progress / 100)), complete, progress };
}

/**
 * A one-line summary of the board's state, for tests and for accessibility.
 * @param {World} world
 */
export function describeBoard(world) {
  const sigils = boardSigils(world);
  const counts = { petition: 0, whisper: 0, dilemma: 0 };
  for (const s of sigils) counts[s.kind] += 1;
  const palette = projectPalette(world);
  return [
    `${counts.petition} petition${counts.petition === 1 ? "" : "s"} waiting`,
    `${counts.dilemma} dilemma${counts.dilemma === 1 ? "" : "s"} waiting`,
    `${counts.whisper} whisper${counts.whisper === 1 ? "" : "s"} unheard`,
    `${feudArcs(world).length} feud arc${feudArcs(world).length === 1 ? "" : "s"}`,
    `the wall at ${Math.round(palette.progress)}%${palette.complete ? " and standing" : ""}`
  ].join(" · ");
}
