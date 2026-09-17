/**
 * Just enough ABI encoding for the calls this project makes.
 *
 * A dependency-free encoder is a deliberate choice: every byte this repo sends
 * to KeeperHub is built here, in code a reviewer can read in one sitting, and
 * the encoding is checked back against the chain (see `decodeUint`) rather than
 * trusted. Only the shapes Fables actually needs are supported.
 */

const HEX = /^0x[0-9a-fA-F]*$/;

const strip = (hex) => {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error(`not hex: ${hex}`);
  return hex.slice(2);
};

/** A 32-byte word, right-aligned. Negative numbers use two's complement, which is what int24 ticks need. */
export function word(value) {
  let n = BigInt(value);
  if (n < 0n) n += 1n << 256n;
  if (n < 0n || n >= 1n << 256n) throw new Error(`out of range: ${value}`);
  return n.toString(16).padStart(64, "0");
}

export const address = (a) => {
  const h = strip(a);
  if (h.length !== 40) throw new Error(`not an address: ${a}`);
  return h.toLowerCase().padStart(64, "0");
};

/** The 4-byte selector of a function signature, taken from a table rather than hashed here. */
export function encode(selector, parts) {
  return selector + parts.join("");
}

/**
 * A dynamic bytes32[]: the head holds the offset, the tail holds length + items.
 * Only one dynamic argument is ever last in the calls below, which keeps the
 * offset arithmetic honest: it is always (number of head words) * 32.
 */
export function bytes32ArrayTail(items, headWords) {
  const head = word(headWords * 32);
  const tail = word(items.length) + items.map((i) => strip(i).padStart(64, "0")).join("");
  return { head, tail };
}

export const decodeUint = (hex) => BigInt(hex === "0x" ? "0x0" : hex);

/** Reads a fixed-size field out of a returned word list. */
export const wordAt = (hex, index) => "0x" + strip(hex).slice(index * 64, (index + 1) * 64);

export const toInt = (hex, bits) => {
  const n = BigInt(hex);
  const max = 1n << BigInt(bits - 1);
  return n >= max ? n - (1n << BigInt(bits)) : n;
};
