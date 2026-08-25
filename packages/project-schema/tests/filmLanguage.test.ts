import { describe, expect, it } from "vitest";
import type { DirectorCameraAspectRatio } from "../src/directorProject";
import {
  DIRECTOR_FILM_PRIME_LENSES_MM,
  DIRECTOR_SHOT_LEVEL_IDS,
  DIRECTOR_SHOT_SIZE_IDS,
  DIRECTOR_SHOT_SIZE_LABELS,
  DIRECTOR_SHOT_VIEW_IDS,
  buildDirectorFramingPhrase,
  deriveDirectorShotLanguage,
  directorShotLanguageReport,
  formatDirectorShotSlate,
  nearestDirectorPrimeLensMm,
  solveDirectorShotFraming,
  type DirectorFramingSubject,
  type DirectorShotFramingIntent,
  type DirectorShotSide,
} from "../src/filmLanguage";

const STANDING: DirectorFramingSubject = {
  position: [0, 0, 0],
  yawRad: 0,
  heightM: 1.72,
};

function roundTrip(intent: DirectorShotFramingIntent, subject: DirectorFramingSubject) {
  const solved = solveDirectorShotFraming(intent, subject);
  const derived = deriveDirectorShotLanguage(
    {
      position: solved.position,
      target: solved.target,
      focalLengthMm: solved.focalLengthMm,
      aspectRatio: intent.aspectRatio,
      sensorFormat: intent.sensorFormat,
    },
    subject,
  );
  return { solved, derived };
}

describe("film language round-trip matrix", () => {
  // Every size × view × side × level combination must solve to a camera pose
  // that derives back to the exact same vocabulary (unless the solver reported
  // a physical adjustment, in which case the derived reading must match the
  // adjusted geometry instead of silently lying).
  const sides: DirectorShotSide[] = ["left", "right"];
  const aspects: DirectorCameraAspectRatio[] = ["16:9", "2.39:1", "9:16"];
  const subjects: Array<[string, DirectorFramingSubject]> = [
    ["adult at origin", STANDING],
    ["short subject, rotated, off origin", { position: [4.2, 0.6, -3.5], yawRad: Math.PI * 0.71, heightM: 1.15 }],
  ];

  for (const [subjectName, subject] of subjects) {
    for (const aspectRatio of aspects) {
      for (const size of DIRECTOR_SHOT_SIZE_IDS) {
        for (const view of DIRECTOR_SHOT_VIEW_IDS) {
          for (const side of sides) {
            for (const level of DIRECTOR_SHOT_LEVEL_IDS) {
              it(`${subjectName} · ${aspectRatio} · ${size} ${view} ${side} ${level}`, () => {
                const intent: DirectorShotFramingIntent = { size, view, side, level, aspectRatio };
                const { solved, derived } = roundTrip(intent, subject);

                expect(derived.size).toBe(size);
                expect(derived.view).toBe(view);
                if (view === "front" || view === "back") {
                  expect(derived.side).toBeNull();
                } else {
                  expect(derived.side).toBe(side);
                }
                if (solved.adjustments.some((adjustment) => adjustment.code === "level-flattened")) {
                  // The reported flattened level must equal what the pose derives to.
                  const flattened = solved.adjustments.find((a) => a.code === "level-flattened")!;
                  expect(flattened.message).toContain(derived.level);
                } else {
                  expect(derived.level).toBe(level);
                }

                // The camera never sits inside the subject.
                expect(solved.distanceM).toBeGreaterThanOrEqual(0.44);
                // Floor-pivot convention: the target sits on the subject's axis.
                expect(solved.target[0]).toBeCloseTo(subject.position[0], 6);
                expect(solved.target[2]).toBeCloseTo(subject.position[2], 6);
              });
            }
          }
        }
      }
    }
  }
});

describe("lens conflicts", () => {
  it("lengthens a wide lens that cannot hold an extreme close-up and reports it", () => {
    const solved = solveDirectorShotFraming(
      { size: "extreme-close-up", view: "front", level: "eye", focalLengthMm: 16 },
      STANDING,
    );
    expect(solved.focalLengthMm).toBeGreaterThan(16);
    expect(DIRECTOR_FILM_PRIME_LENSES_MM).toContain(solved.focalLengthMm);
    expect(solved.adjustments.some((adjustment) => adjustment.code === "lens-extended")).toBe(true);
    const derived = deriveDirectorShotLanguage(
      { position: solved.position, target: solved.target, focalLengthMm: solved.focalLengthMm },
      STANDING,
    );
    expect(derived.size).toBe("extreme-close-up");
  });

  it("lengthens the lens when an overhead level needs more rise than the distance allows", () => {
    const solved = solveDirectorShotFraming(
      { size: "close-up", view: "front", level: "overhead", focalLengthMm: 24 },
      STANDING,
    );
    expect(solved.focalLengthMm).toBeGreaterThan(24);
    expect(solved.adjustments.some((adjustment) => adjustment.code === "lens-extended")).toBe(true);
    const derived = deriveDirectorShotLanguage(
      { position: solved.position, target: solved.target, focalLengthMm: solved.focalLengthMm },
      STANDING,
    );
    expect(derived.level).toBe("overhead");
    expect(derived.size).toBe("close-up");
  });

  it("honours an explicit non-prime lens when no conflict exists", () => {
    const solved = solveDirectorShotFraming(
      { size: "medium", view: "profile", side: "left", level: "eye", focalLengthMm: 47 },
      STANDING,
    );
    expect(solved.focalLengthMm).toBe(47);
    expect(solved.adjustments).toHaveLength(0);
    const derived = deriveDirectorShotLanguage(
      { position: solved.position, target: solved.target, focalLengthMm: 47 },
      STANDING,
    );
    // The crew reports the nearest prime while keeping the exact value.
    expect(derived.focalLengthMm).toBe(50);
    expect(derived.exactFocalLengthMm).toBe(47);
  });
});

describe("derive from raw geometry", () => {
  it("classifies a distant low camera as an extreme wide from the ground", () => {
    const derived = deriveDirectorShotLanguage(
      { position: [0, 0.1, 30], target: [0, 1, 0], focalLengthMm: 24 },
      STANDING,
    );
    expect(derived.size).toBe("extreme-wide");
    expect(derived.level).toBe("ground");
    expect(derived.view).toBe("front");
    expect(derived.side).toBeNull();
  });

  it("names the camera side from the subject's own left and right", () => {
    // Subject faces +Z; its right hand points toward -X.
    const onRight = deriveDirectorShotLanguage(
      { position: [-3, 1.6, 0.2], target: [0, 1.2, 0], focalLengthMm: 50 },
      STANDING,
    );
    expect(onRight.view).toBe("profile");
    expect(onRight.side).toBe("right");
    const onLeft = deriveDirectorShotLanguage(
      { position: [3, 1.6, 0.2], target: [0, 1.2, 0], focalLengthMm: 50 },
      STANDING,
    );
    expect(onLeft.side).toBe("left");
  });

  it("respects the cropped gate: a 9:16 crop reads tighter than 16:9 at one distance", () => {
    const wideCrop = deriveDirectorShotLanguage(
      { position: [0, 1.6, 4], target: [0, 1.2, 0], focalLengthMm: 35, aspectRatio: "16:9" },
      STANDING,
    );
    const tallCrop = deriveDirectorShotLanguage(
      { position: [0, 1.6, 4], target: [0, 1.2, 0], focalLengthMm: 35, aspectRatio: "9:16" },
      STANDING,
    );
    // The portrait crop uses the full gate height, so the subject occupies
    // less of the frame vertically than under the 16:9 crop.
    expect(tallCrop.subjectScreenFraction).toBeLessThan(wideCrop.subjectScreenFraction);
  });

  it("measures distance to the mid-body pivot, not the bounding-box midpoint", () => {
    const floorCam = deriveDirectorShotLanguage(
      { position: [0, 0.15, 2], target: [0, 1.5, 0], focalLengthMm: 35 },
      STANDING,
    );
    expect(floorCam.distanceM).toBeGreaterThan(2);
    expect(floorCam.distanceM).toBeLessThan(2.6);
  });
});

describe("slate and phrase", () => {
  it("formats a compact uppercase slate", () => {
    const { derived } = roundTrip({ size: "medium", view: "front-quarter", side: "right", level: "eye" }, STANDING);
    expect(formatDirectorShotSlate(derived)).toBe("MEDIUM · FRONT-QUARTER R · EYE · 50MM");
  });

  it("builds an English phrase that claims the measured geometry", () => {
    const { derived } = roundTrip({ size: "close-up", view: "profile", side: "left", level: "hip" }, STANDING);
    const phrase = buildDirectorFramingPhrase(derived);
    expect(phrase).toContain("close-up");
    expect(phrase).toContain("85mm");
    expect(phrase).toContain("hip-level");
    expect(phrase).toContain("left-side profile");
  });

  it("serializes a snake_case wire report with slate and phrase", () => {
    const { derived } = roundTrip({ size: "full", view: "back", level: "high" }, STANDING);
    const report = directorShotLanguageReport(derived);
    expect(report.size).toBe("full");
    expect(report.view).toBe("back");
    expect(report.side).toBeNull();
    expect(report.level).toBe("high");
    expect(report.slate).toContain("FULL");
    expect(report.phrase).toContain("full shot");
    expect(report.distance_m).toBeGreaterThan(0);
  });

  it("keeps prime snapping stable at midpoints", () => {
    expect(nearestDirectorPrimeLensMm(17)).toBe(16);
    expect(nearestDirectorPrimeLensMm(42)).toBe(35);
    expect(nearestDirectorPrimeLensMm(43)).toBe(50);
    expect(nearestDirectorPrimeLensMm(300)).toBe(135);
  });

  it("provides Chinese source labels for every size", () => {
    for (const size of DIRECTOR_SHOT_SIZE_IDS) {
      expect(DIRECTOR_SHOT_SIZE_LABELS[size]).toBeTruthy();
    }
  });
});
