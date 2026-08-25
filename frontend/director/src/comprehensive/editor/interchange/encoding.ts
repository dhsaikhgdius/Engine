/**
 * Encodes a UTF-8 string as a standard Base64 string.
 *
 * Handles large strings in 32 KiB chunks to avoid exceeding the
 * maximum argument count of `String.fromCharCode`.
 *
 * @param value - The raw UTF-8 string to encode.
 * @returns The Base64-encoded string.
 */
export function encodeUtf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  // Process in 32 KiB chunks to stay under the spread-operator argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Decodes a standard Base64 string back to UTF-8.
 *
 * @param value - The Base64-encoded string.
 * @returns The decoded UTF-8 string.
 */
export function decodeUtf8Base64(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
