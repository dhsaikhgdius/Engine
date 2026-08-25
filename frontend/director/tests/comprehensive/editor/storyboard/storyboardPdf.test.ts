import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildDirectorStoryboardRasterPdf,
  createDirectorStoryboardVerificationPackage,
  DIRECTOR_STORYBOARD_PDF_CONTRACT,
  DIRECTOR_STORYBOARD_PDF_FILE_NAME,
  selectDirectorStoryboardExportShots,
  verifyDirectorStoryboardPdfResult,
  type DirectorStoryboardPdfPage,
  type DirectorStoryboardPdfResult,
} from "../../../../src/comprehensive/editor/storyboard/storyboardPdf";

function page(index: number, shotId: string): DirectorStoryboardPdfPage {
  return {
    index,
    widthPoints: 841.89,
    heightPoints: 595.28,
    widthPixels: 1684,
    heightPixels: 1191,
    shotIds: [shotId],
    jpegBytes: Uint8Array.from([0xff, 0xd8, index, 1, 2, 3, 0xff, 0xd9]),
  };
}

function lastByteSequence(bytes: Uint8Array, pattern: string) {
  const query = new TextEncoder().encode(pattern);
  for (let start = bytes.length - query.length; start >= 0; start -= 1) {
    if (query.every((value, offset) => bytes[start + offset] === value)) return start;
  }
  return -1;
}

function resultFixture(): DirectorStoryboardPdfResult {
  const pages = [page(1, "shot-a"), page(2, "shot-b")];
  const pdfBytes = buildDirectorStoryboardRasterPdf(pages, "可验证分镜");
  return {
    pages,
    pdfBytes,
    manifest: {
      contract: DIRECTOR_STORYBOARD_PDF_CONTRACT,
      createdAt: "2026-08-07T00:00:00.000Z",
      storyboard: { title: "可验证分镜", logline: "" },
      settings: {
        paperSize: "a4",
        orientation: "landscape",
        columns: 1,
        scope: "all",
        selectedShotIds: [],
        includeMetadata: true,
        includeAction: true,
      },
      shots: [],
      pages: pages.map((entry) => ({
        index: entry.index,
        path: `pages/page-${String(entry.index).padStart(3, "0")}.jpg`,
        widthPoints: entry.widthPoints,
        heightPoints: entry.heightPoints,
        widthPixels: entry.widthPixels,
        heightPixels: entry.heightPixels,
        shotIds: entry.shotIds,
        bytes: entry.jpegBytes.length,
      })),
      pdf: {
        path: DIRECTOR_STORYBOARD_PDF_FILE_NAME,
        bytes: pdfBytes.length,
      },
      warnings: [],
    },
  };
}

describe("storyboard raster PDF", () => {
  it("writes complete page/image/content objects and a byte-accurate xref", () => {
    const bytes = resultFixture().pdfBytes;
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("%PDF-1.7");
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("/Type /Pages /Count 2");
    expect(text).toContain("/Subtype /Image /Width 1684 /Height 1191");
    expect(text).toContain("xref\n0 10");
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const startXref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(startXref).toBe(lastByteSequence(bytes, "\nxref\n") + 1);
  });

  it("checks file sizes and packages the PDF, manifest, and page images", async () => {
    const result = resultFixture();
    expect(verifyDirectorStoryboardPdfResult(result)).toBe(true);
    const archive = await createDirectorStoryboardVerificationPackage(result);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer(), { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual([
      "director-storyboard.pdf",
      "manifest.json",
      "pages/",
      "pages/page-001.jpg",
      "pages/page-002.jpg",
    ]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest).toMatchObject({ contract: DIRECTOR_STORYBOARD_PDF_CONTRACT, pdf: result.manifest.pdf });

    result.pdfBytes = result.pdfBytes.slice(0, -1);
    expect(() => verifyDirectorStoryboardPdfResult(result)).toThrow("PDF 文件大小不一致");
  });

  it("keeps storyboard order while applying a selected-only export scope", () => {
    const shots = [
      { id: "late", frameStart: 20, frameEnd: 29 },
      { id: "early", frameStart: 0, frameEnd: 9 },
      { id: "middle", frameStart: 10, frameEnd: 19 },
    ] as never;
    expect(
      selectDirectorStoryboardExportShots(shots, { scope: "selected", selectedShotIds: ["late", "early"] }).map(
        (shot) => shot.id,
      ),
    ).toEqual(["early", "late"]);
  });
});
