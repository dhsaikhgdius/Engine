/** A comparison function that imposes a total order on string keys. */
type KeyComparator = (left: string, right: string) => number;

/**
 * Recursively stringify a value into a deterministic JSON representation.
 *
 * Objects are serialized with keys sorted by the provided comparator.
 * Array elements are serialized in their original order.
 * `undefined` values are stripped from objects.
 *
 * @param value - The value to serialize.
 * @param compareKeys - The key ordering comparator to use.
 * @returns A deterministic JSON string.
 */
function stringifyStableJson(value: unknown, compareKeys: KeyComparator): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stringifyStableJson(entry, compareKeys)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStableJson(entry, compareKeys)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Produce a deterministic JSON string with locale-aware key ordering.
 *
 * Keys are sorted via `String.prototype.localeCompare`, which respects the host locale.
 * Use this when the output is consumed by a human or when locale-specific ordering is
 * part of the system contract.
 *
 * @param value - The value to serialize.
 * @returns A deterministic JSON string with locale-aware key order.
 */
export function stableJson(value: unknown): string {
  return stringifyStableJson(value, (left, right) => left.localeCompare(right));
}

/**
 * Produce a deterministic JSON string with code-point (lexical) key ordering.
 *
 * Keys are sorted by raw code-point comparison (`<` / `>`), which is portable across
 * all locales and environments. Use this when the output is used as a cryptographic
 * fingerprint or a cross-environment cache key.
 *
 * @param value - The value to serialize.
 * @returns A deterministic JSON string with lexical key order.
 */
export function stableLexicalJson(value: unknown): string {
  return stringifyStableJson(value, (left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
