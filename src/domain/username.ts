// Slug username generator.
//
// On every registration we mint an auto-generated username in the shape
// `adjective-noun-NNN` (e.g. "fast-otter-042"). This keeps the public URLs
// (/u/:username) human-friendly without asking the user to pick anything
// up-front; they can rename later if we ship that feature.
//
// The function is pure domain logic: it takes a caller-supplied `exists`
// probe rather than a Kysely instance so we can unit-test the retry path
// without D1, and so the call-site in Better Auth's createUser hook
// stays small.

// Curated word lists. Chosen to be unambiguous, safe-for-work, and
// largely single-syllable so generated usernames stay short and
// pronounceable. Word counts are comfortably above 100 each, giving
// ~10k adjective-noun combinations before the NNN suffix widens the
// space to ~10m total — collision retry is therefore a rare fallback.
const ADJECTIVES: readonly string[] = [
  "fast",
  "quick",
  "swift",
  "steady",
  "sturdy",
  "silent",
  "stoic",
  "brave",
  "bold",
  "calm",
  "clever",
  "crafty",
  "cunning",
  "daring",
  "deft",
  "eager",
  "even",
  "fierce",
  "fine",
  "firm",
  "fluid",
  "gentle",
  "glad",
  "graceful",
  "grand",
  "hardy",
  "hasty",
  "honest",
  "humble",
  "ideal",
  "jovial",
  "keen",
  "kind",
  "lively",
  "loyal",
  "lucid",
  "lucky",
  "merry",
  "mighty",
  "mild",
  "modest",
  "neat",
  "nimble",
  "noble",
  "patient",
  "plucky",
  "polite",
  "precise",
  "proud",
  "prudent",
  "quiet",
  "ready",
  "ruddy",
  "shiny",
  "sharp",
  "sleek",
  "snug",
  "sober",
  "solid",
  "sound",
  "spry",
  "stable",
  "strong",
  "subtle",
  "sunny",
  "tame",
  "taut",
  "terse",
  "tidy",
  "tireless",
  "trusty",
  "warm",
  "wise",
  "witty",
  "zealous",
  "amber",
  "azure",
  "copper",
  "crimson",
  "golden",
  "iron",
  "ivory",
  "jade",
  "onyx",
  "pearl",
  "ruby",
  "silver",
  "vivid",
  "agile",
  "bright",
  "candid",
  "earnest",
  "frank",
  "robust",
  "shrewd",
  "staunch",
  "steadfast",
  "tenacious",
  "upright",
  "valiant",
  "vigilant",
  "zesty",
  "adept",
  "astute",
  "canny",
  "dashing",
  "glowing",
  "hale",
  "lithe",
  "poised",
  "radiant",
  "rugged",
  "savvy",
  "serene",
  "intrepid",
  "mellow",
  "nifty",
  "regal",
  "sprightly",
  "gallant",
  "buoyant",
  "chipper",
  "dapper",
  "earthy",
  "fleet",
  "genial",
  "jaunty",
];

const NOUNS: readonly string[] = [
  "otter",
  "falcon",
  "hawk",
  "eagle",
  "sparrow",
  "robin",
  "owl",
  "raven",
  "crow",
  "heron",
  "puffin",
  "gull",
  "tern",
  "swan",
  "goose",
  "duck",
  "stork",
  "crane",
  "ibis",
  "lark",
  "wren",
  "finch",
  "magpie",
  "kestrel",
  "osprey",
  "merlin",
  "hornet",
  "beetle",
  "cricket",
  "firefly",
  "moth",
  "dragonfly",
  "mantis",
  "anchor",
  "arbor",
  "atlas",
  "axis",
  "beacon",
  "bramble",
  "breeze",
  "brook",
  "canyon",
  "cedar",
  "clover",
  "comet",
  "cove",
  "crest",
  "delta",
  "dune",
  "ember",
  "fjord",
  "forge",
  "frost",
  "glacier",
  "grove",
  "harbor",
  "isle",
  "lantern",
  "lattice",
  "meadow",
  "mesa",
  "mirror",
  "mountain",
  "oak",
  "orbit",
  "peak",
  "pebble",
  "pine",
  "plume",
  "prairie",
  "quartz",
  "reed",
  "ridge",
  "river",
  "rune",
  "sable",
  "sage",
  "shore",
  "spruce",
  "stone",
  "summit",
  "tide",
  "timber",
  "valley",
  "willow",
  "zenith",
  "badger",
  "beaver",
  "bison",
  "cougar",
  "coyote",
  "deer",
  "ferret",
  "fox",
  "gecko",
  "hare",
  "heifer",
  "ibex",
  "jackal",
  "lynx",
  "marten",
  "moose",
  "panda",
  "puma",
  "rabbit",
  "raccoon",
  "stoat",
  "wolf",
  "wolverine",
  "yak",
];

const MAX_RETRIES = 5;

/**
 * Dependency shape the generator needs. An existence probe is enough;
 * the caller decides whether to ask Kysely, a mock, or something else.
 */
export interface SlugUsernameDeps {
  exists(username: string): Promise<boolean>;
}

function pickRandom<T>(list: readonly T[]): T {
  // Word lists are non-empty constants above. Assert + fallback keeps
  // TypeScript's noUncheckedIndexedAccess happy without a cast.
  if (list.length === 0) throw new Error("word list must be non-empty");
  const idx = Math.floor(Math.random() * list.length);
  return list[idx]!;
}

function formatNumber(n: number): string {
  return n.toString().padStart(3, "0");
}

function makeCandidate(): string {
  const adjective = pickRandom(ADJECTIVES);
  const noun = pickRandom(NOUNS);
  const suffix = formatNumber(Math.floor(Math.random() * 1000));
  return `${adjective}-${noun}-${suffix}`;
}

/**
 * Generate a unique slug username. Retries up to MAX_RETRIES times if a
 * candidate collides with an existing user. After that many collisions
 * we fall back to `user-<unix-ms>` — globally unique in practice because
 * D1 is single-writer per request and Date.now() advances monotonically.
 */
export async function generateSlugUsername(deps: SlugUsernameDeps): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const candidate = makeCandidate();
    if (!(await deps.exists(candidate))) {
      return candidate;
    }
  }
  return `user-${Date.now()}`;
}
