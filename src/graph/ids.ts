/**
 * Deterministic id allocation.
 *
 * Tdarr's own editor uses random nanoids, but `build()` has to be pure: the
 * golden test compares generated flows byte for byte, the web app recompiles on
 * every keystroke, and a flow whose ids churn produces a meaningless diff
 * against the copy already on the server. So ids are derived from content and
 * ordinal instead of drawn from a generator.
 */

/** Tdarr node ids are 9 characters of nanoid's URL-safe alphabet. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ID_LENGTH = 9;

/**
 * FNV-1a. Not for security - just a cheap, stable, dependency-free way to turn a
 * seed string into a fixed-width id that looks like the ones Tdarr writes.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashId(seed: string, length = ID_LENGTH): string {
  let out = '';
  // Rehash with a counter so 9 characters do not have to come out of 32 bits.
  for (let block = 0; out.length < length; block++) {
    let hash = fnv1a(`${seed}#${block}`);
    for (let i = 0; i < 5 && out.length < length; i++) {
      out += ALPHABET[hash % ALPHABET.length];
      hash = Math.floor(hash / ALPHABET.length);
    }
  }
  return out;
}

/**
 * Allocates ids for one build. Seeded by flow name so two flows in the same
 * session do not collide, and by ordinal so a repeated plugin still gets
 * distinct ids.
 */
export class IdAllocator {
  #seed: string;
  #ordinal = 0;
  #used = new Set<string>();

  constructor(seed: string) {
    this.#seed = seed;
  }

  /** Reserve a caller-supplied id, so generated ones never shadow it. */
  claim(id: string): string {
    if (this.#used.has(id)) {
      throw new Error(`duplicate node id: ${id}`);
    }
    this.#used.add(id);
    return id;
  }

  next(ref: string): string {
    const ordinal = this.#ordinal++;
    let id = hashId(`${this.#seed}:${ref}:${ordinal}`);
    // Collisions are vanishingly unlikely at 64^9, but a silent one would merge
    // two nodes, so probe rather than trust the odds.
    for (let attempt = 1; this.#used.has(id); attempt++) {
      id = hashId(`${this.#seed}:${ref}:${ordinal}:${attempt}`);
    }
    this.#used.add(id);
    return id;
  }
}

/** Edge ids only have to be unique within the flow; Tdarr does not read them. */
export function edgeId(index: number): string {
  return `e${index}`;
}
