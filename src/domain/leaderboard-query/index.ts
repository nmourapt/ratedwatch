// Barrel export for the leaderboard-query domain module. Mirrors the
// shape of src/domain/drift-calc so consumers never reach into the
// internal file layout.
export { queryLeaderboard, type LeaderboardOpts, type RankedWatch } from "./query";
