/**
 * Encode a UTF-8 string as a base64 string.
 * Processes in 32 KiB chunks to avoid stack overflow on large inputs.
 *
 * @param value - The string to encode.
 * @returns A base64-encoded representation.
 */
export function encodeUtf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Decode a base64 string back to a UTF-8 string.
 *
 * @param value - The base64-encoded string.
 * @returns The decoded UTF-8 string.
 */
export function decodeUtf8Base64(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
