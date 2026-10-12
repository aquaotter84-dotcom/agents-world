/**
 * Durable shared construction projects. The initial wall project is part of
 * the world state (not a UI quest), so its progress survives saves and its
 * milestones feed directly into decisions and social consequences.
 */
/**
 * @returns {{
 *   id: string,
 *   title: string,
 *   regionId: string,
 *   status: "active"|"complete",
 *   progress: number,
 *   milestones: {id: string, title: string, threshold: number, reached: boolean, tick: number|null}[],
 *   contributors: Record<string, {work: number, help: number, interference: number, lastTick: number, lastInterferenceTick?: number}>,
 *   interferenceCount: number,
 *   lastWorkTick: number,
 *   completedTick: number|null,
 *   completionContributors: string[]
 * }}
 */
export function createNorthWallProject() {
  return {
    id: "north-wall",
    title: "Raise the North Wall",
    regionId: "wall",
    status: "active",
    progress: 0,
    milestones: [
      { id: "survey", title: "The breach is mapped", threshold: 20, reached: false, tick: null },
      { id: "materials", title: "Stone and timber are gathered", threshold: 45, reached: false, tick: null },
      { id: "course", title: "The broken course is raised", threshold: 75, reached: false, tick: null },
      { id: "reinforced", title: "The North Wall stands reinforced", threshold: 100, reached: false, tick: null }
    ],
    contributors: {},
    interferenceCount: 0,
    lastWorkTick: 0,
    completedTick: null,
    completionContributors: []
  };
}
