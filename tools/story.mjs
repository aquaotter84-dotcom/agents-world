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
    let best = m.options[0], bestScore = -1;
    for (const o of m.options) {
      const drive = TONE[o.tone] || "focus";
      const v = drive === "esteem" ? 100 - a.needs.esteem : drive === "meaning" ? a.needs.meaning : a.drives[drive] ?? 50;
      if (v > bestScore) { bestScore = v; best = o; }
    }
    resolveMoment(world, m.id, { optionId: best.id, prose: null });
  }
}

// Print one full day, in order.
const dayStart = world.events.filter(e => e.tick <= 480).length;
const target = world.events.filter(e => e.tick > 430 && e.tick <= 478).slice().reverse();
console.log(`=== Day ${world.clock.day - 1} ===`);
for (const e of target) {
  const who = e.agentId ? agentById(world, e.agentId) : null;
  const tag = e.significance >= 0.55 ? "**" : e.significance >= 0.3 ? "* " : "  ";
  console.log(`${tag}[${e.kind}] ${e.text}`);
}
console.log("\n=== Chronicle ===");
world.chronicle.slice(-3).forEach(c => console.log(`Day ${c.day}: ${c.summary}\n`));
