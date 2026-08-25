/**
 * Clamp a numeric value to a closed interval.
 *
 * @param value - The number to clamp.
 * @param minimum - The lower bound (inclusive).
 * @param maximum - The upper bound (inclusive).
 * @returns The value clamped so that `minimum ≤ result ≤ maximum`.
 */
export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Type-narrow a value to a plain object (not an array, not null).
 *
 * @param value - The value to test.
 * @returns `true` when the value is a non-null object that is not an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert a value to a plain object, returning `null` when it is not one.
 *
 * @param value - The value to convert.
 * @returns The value as a `Record<string, unknown>` when it is a plain object, or `null` otherwise.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Return the string keys of an object, typed as a non-empty tuple of the object's own keys.
 *
 * This is a typed wrapper over `Object.keys` that preserves the key set at the type level.
 *
 * @param value - The object whose keys to extract.
 * @returns A non-empty tuple of the object's string keys.
 */
export function protocolKeys<T extends object>(value: T) {
  return Object.keys(value) as [Extract<keyof T, string>, ...Extract<keyof T, string>[]];
}

/**
 * Return a numeric value when it is finite, or a fallback otherwise.
 *
 * Useful for guarding against `NaN` and `Infinity` values that can arise from parse failures.
 *
 * @param value - The value to test.
 * @param fallback - The fallback number to return when `value` is not finite.
 * @returns `value` when it is a finite number, otherwise `fallback`.
 */
export function finiteNumberOr(value: unknown, fallback: number) {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/**
 * Extract a human-readable message from an unknown error value.
 *
 * @param error - The error value (typically from a `catch` clause).
 * @returns The error's `message` property when it is an `Error` instance, otherwise the string representation of the value.
 */
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compare two strings for sorting, returning -1, 0, or 1.
 *
 * @param left - The left-hand string.
 * @param right - The right-hand string.
 * @returns -1 when `left < right`, 0 when equal, 1 when `left > right`.
 */
export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Normalize an asset catalog claim string into a canonical, search-friendly form.
 *
 * The normalization applies NFKC Unicode normalization, strips recognised file extensions
 * (.fbx, .glb, .gltf, .vrm, .obj), lowercases with the `en-US` locale, collapses any
 * sequence of non-alphanumeric characters into a single space, and trims leading/trailing
 * whitespace. The result is suitable for deduplication and fuzzy matching.
 *
 * @param value - The raw asset catalog claim string.
 * @returns The normalized claim string.
 */
export function normalizeAssetCatalogClaim(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\.(?:fbx|glb|gltf|vrm|obj)$/i, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Parse a string into a finite number, falling back to a default when parsing fails.
 *
 * @param value - The string to parse.
 * @param fallback - The fallback number to return when the parse result is not finite.
 * @returns The parsed number when finite, otherwise `fallback`.
 */
export function parseFiniteNumber(value: string, fallback: number) {
  return finiteNumberOr(Number(value), fallback);
}

/**
 * Replace one axis value in a 3D tuple, returning a new tuple.
 *
 * @param tuple - The source `[x, y, z]` tuple.
 * @param axis - The axis to replace: 0 (x), 1 (y), or 2 (z).
 * @param value - The new value for the chosen axis.
 * @returns A new `[x, y, z]` tuple with the specified axis replaced.
 */
export function replaceTupleAxis(
  tuple: readonly [number, number, number],
  axis: 0 | 1 | 2,
  value: number,
): [number, number, number] {
  return tuple.map((item, index) => (index === axis ? value : item)) as [number, number, number];
}