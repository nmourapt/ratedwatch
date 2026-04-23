// Barrel export for the drift-calc domain module. Keeps consumers
// (routes, SPA) from reaching into the internal file layout.
export {
  computeSessionStats,
  type Reading,
  type PerIntervalDrift,
  type SessionStats,
} from "./compute-session-stats";
