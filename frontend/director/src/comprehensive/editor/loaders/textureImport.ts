const TEXTURE_EXTENSION_RE = /\.(jpe?g|png|webp|avif)$/i;

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("材质贴图读取失败"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("材质贴图读取失败")));
    reader.readAsDataURL(file);
  });
}

/**
 * Reads a texture image file and returns its data URL representation.
 *
 * The texture is encoded as a base64 data URL so it can be stored inline
 * in the project without requiring a separate upload step.
 *
 * @param file - The image file selected by the user.
 * @returns The texture asset with fileName, display name, and data URL.
 * @throws If the file extension is not supported (JPG, PNG, WEBP, AVIF).
 */
export async function readTextureFile(file: File) {
  if (!TEXTURE_EXTENSION_RE.test(file.name)) {
    throw new Error("当前仅支持 JPG / PNG / WEBP / AVIF 材质贴图");
  }
  return {
    fileName: file.name,
    name: file.name.replace(TEXTURE_EXTENSION_RE, ""),
    url: await readFileAsDataUrl(file),
  };
}
