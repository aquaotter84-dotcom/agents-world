import { createWorld, agentById } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { generateIntents } from "../engine/decision/intents.js";

const world = createWorld({ seed: 4711 });
// A stand-in for the model: chooses the option that best matches the mind's
// temperament, and writes a line naming its reasons. Not real prose, but it
// exercises the same path the LLM will.
const TONE = { bold:"courage", ruthless:"courage", measured:"focus", calculated:"focus",
  guarded:"focus", warm:"social", open:"social", easy:"social", probing:"social",
  stoic:"focus", still:"focus", restrained:"focus", dark:"esteem", graceful:"meaning",
  restless:"creativity", steady:"focus" };

for (let i = 0; i < 480; i++) {
  step(world);
  for (const m of [...world.pending]) {
    const a = agentById(world, m.agentId);
    // Not every moment is a choice between options: a cognition plan, a
    // petition, a whisper and a goal approach are proposals the model writes.
    // There is nothing to rank, and the engine answers those itself.
    if (!m.options || !m.options.length) {
      resolveMoment(world, m.id, {});
      continue;
    }
    let best = m.options[0], bestScore = -1;
    for (const o of m.options) {
      const drive = TONE[o.tone] || "focus";
      const v = drive === "esteem" ? 100 - a.needs.esteem : drive === "meaning" ? a.needs.meaning : a.drives[drive] ?? 50;
      if (v > bestScore) { bestScore = v; best = o; }
    }
    resolveMoment(world, m.id, { optionId: best.id, prose: null });
  }
}

/*
 * Print one full day, in order — as a story rather than as a log.
 *
 * A tick of nine minds writes four lines and half of them are the simulation
 * keeping its own books: opinion deltas between pairs, minds that considered
 * asking the keeper for something and did not, moments the model never answered
 * in time. Reading the raw log is how that gets missed — the drama is in there,
 * spread thin. This prints the beats and counts what it left out; `--all` prints
 * every line, which is what the record does.
 *
 * Marks match the app's own reading of `significance`: `**` a moment (0.85+),
 * `* ` a beat (0.6+), and nothing for the texture underneath.
 */
const showAll = process.argv.includes("--all");
const BOOKKEEPING_KINDS = new Set(["relationship"]);
const PLUMBING = [
  /wanted to petition the keeper, but had nothing in the world to point at/,
  /started to tell the keeper something and stopped/,
  /No answer arrived in time; the engine made the call/
];
const isBookkeeping = e =>
  BOOKKEEPING_KINDS.has(e.kind) ||
  (e.kind === "proposal" && !e.authored) ||
  PLUMBING.some(rx => rx.test(e.text || ""));

const target = world.events.filter(e => e.tick > 430 && e.tick <= 478).slice().reverse();
console.log(`=== Day ${world.clock.day - 1} ===`);
let hidden = 0;
for (const e of target) {
  if (!showAll && isBookkeeping(e)) { hidden += 1; continue; }
  const who = e.agentId ? agentById(world, e.agentId) : null;
  const tag = e.significance >= 0.85 ? "**" : e.significance >= 0.6 ? "* " : "  ";
  console.log(`${tag}[${e.kind}] ${e.text}`);
}
if (hidden) console.log(`\n(${hidden} quieter lines not shown — the day's full record is \`--all\`)`);
console.log("\n=== Chronicle ===");
world.chronicle.slice(-3).forEach(c => console.log(`Day ${c.day}: ${c.summary}\n`));
