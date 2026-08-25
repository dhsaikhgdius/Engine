function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function linearToSrgb(value: number) {
  const channel = clampUnit(value);
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function srgbToLinear(value: number) {
  const channel = clampUnit(value);
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function colorChannelToHex(value: number) {
  return Math.round(linearToSrgb(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Converts a linear RGB triplet to a hex color string (sRGB gamut).
 *
 * Blender stores color in linear space; this bridges the gap to
 * hex strings that most interchange formats expect.
 *
 * @param rgb - Linear RGB values, each in [0, 1].
 * @returns A CSS hex string like `#rrggbb`.
 */
export function linearRgbToHex(rgb: [number, number, number]) {
  return `#${rgb.map(colorChannelToHex).join("")}`;
}

/**
 * Parses a CSS hex color string into a linear RGB triplet.
 *
 * @param value - A hex color string like `#rrggbb`.
 * @returns Linear RGB values, each in [0, 1].
 */
export function hexToLinearRgb(value: string): [number, number, number] {
  return [1, 3, 5].map((offset) => srgbToLinear(Number.parseInt(value.slice(offset, offset + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
}
