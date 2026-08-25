import { describe, expect, it } from "vitest";
import {
  buildDirectorCameraMovePhrase,
  describeDirectorCameraMove,
  directorMoveEase,
  formatDirectorCameraMoveSlate,
  interpolateDirectorCameraFraming,
  shortestAngleRad,
  type DirectorCameraMoveId,
} from "../src/cameraMoveLanguage";
import {
  solveDirectorShotFraming,
  type DirectorCameraFraming,
  type DirectorFramingSubject,
  type DirectorShotFramingIntent,
} from "../src/filmLanguage";

const SUBJECT: DirectorFramingSubject = { position: [0, 0, 0], yawRad: 0, heightM: 1.72 };

function framingOf(intent: DirectorShotFramingIntent): DirectorCameraFraming {
  const solved = solveDirectorShotFraming(intent, SUBJECT);
  return { position: solved.position, target: solved.target, focalLengthMm: solved.focalLengthMm };
}

describe("shortestAngleRad", () => {
  it("takes the short way around the circle", () => {
    expect(shortestAngleRad(0.1, TWO_PI_MINUS(0.1))).toBeCloseTo(-0.2, 6);
    expect(shortestAngleRad(-Math.PI / 2, Math.PI / 2)).toBeCloseTo(Math.PI, 6);
    expect(shortestAngleRad(1, 1)).toBe(0);
  });
});

function TWO_PI_MINUS(value: number) {
  return Math.PI * 2 - value;
}

describe("interpolateDirectorCameraFraming", () => {
  const a = framingOf({ size: "full", view: "front-quarter", side: "right", level: "eye" });
  const b = framingOf({ size: "close-up", view: "profile", side: "right", level: "hip" });

  it("reproduces the endpoints exactly", () => {
    const at0 = interpolateDirectorCameraFraming(a, b, { x: 0, z: 0 }, 0);
    const at1 = interpolateDirectorCameraFraming(a, b, { x: 0, z: 0 }, 1);
    at0.position.forEach((value, index) => expect(value).toBeCloseTo(a.position[index], 6));
    at1.position.forEach((value, index) => expect(value).toBeCloseTo(b.position[index], 6));
    expect(at0.focalLengthMm).toBeCloseTo(a.focalLengthMm, 6);
    expect(at1.focalLengthMm).toBeCloseTo(b.focalLengthMm, 6);
  });

  it("orbits around the subject instead of cutting through the chord", () => {
    const left = framingOf({ size: "medium", view: "profile", side: "left", level: "eye" });
    const right = framingOf({ size: "medium", view: "profile", side: "right", level: "eye" });
    const mid = interpolateDirectorCameraFraming(left, right, { x: 0, z: 0 }, 0.5);
    const radius = Math.hypot(mid.position[0], mid.position[2]);
    const endRadius = Math.hypot(right.position[0], right.position[2]);
    // A chord blend would collapse the radius near zero at the midpoint.
    expect(radius).toBeCloseTo(endRadius, 1);
  });

  it("eases smoothly and monotonically", () => {
    expect(directorMoveEase(0)).toBe(0);
    expect(directorMoveEase(1)).toBe(1);
    let previous = 0;
    for (let step = 1; step <= 20; step += 1) {
      const value = directorMoveEase(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("describeDirectorCameraMove classification matrix", () => {
  const eyeFull = () => framingOf({ size: "full", view: "front", level: "eye" });

  const cases: Array<[string, () => [DirectorCameraFraming, DirectorCameraFraming], DirectorCameraMoveId]> = [
    ["identical framings hold still", () => [eyeFull(), eyeFull()], "static"],
    [
      "lens change without movement zooms in",
      () => {
        const a = eyeFull();
        return [a, { ...a, focalLengthMm: a.focalLengthMm + 30 }];
      },
      "zoom-in",
    ],
    [
      "lens change without movement zooms out",
      () => {
        const a = framingOf({ size: "medium", view: "front", level: "eye" });
        return [a, { ...a, focalLengthMm: a.focalLengthMm - 25 }];
      },
      "zoom-out",
    ],
    [
      "aim swing to the right pans right",
      () => {
        const a = eyeFull();
        return [a, { ...a, target: [a.target[0] + 4, a.target[1], a.target[2]] }];
      },
      "pan-right",
    ],
    [
      "aim swing to the left pans left",
      () => {
        const a = eyeFull();
        return [a, { ...a, target: [a.target[0] - 4, a.target[1], a.target[2]] }];
      },
      "pan-left",
    ],
    [
      "aim lift tilts up",
      () => {
        const a = eyeFull();
        return [a, { ...a, target: [a.target[0], a.target[1] + 4, a.target[2]] }];
      },
      "tilt-up",
    ],
    [
      "aim drop tilts down",
      () => {
        const a = eyeFull();
        return [a, { ...a, target: [a.target[0], a.target[1] - 4, a.target[2]] }];
      },
      "tilt-down",
    ],
    [
      "closing distance pushes in",
      () =>
        [
          framingOf({ size: "full", view: "front", level: "eye", focalLengthMm: 35 }),
          framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 35 }),
        ] as [DirectorCameraFraming, DirectorCameraFraming],
      "push-in",
    ],
    [
      "opening distance pulls out",
      () =>
        [
          framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 35 }),
          framingOf({ size: "wide", view: "front", level: "eye", focalLengthMm: 35 }),
        ] as [DirectorCameraFraming, DirectorCameraFraming],
      "pull-out",
    ],
    [
      "rising lens cranes up",
      () =>
        [
          framingOf({ size: "full", view: "front", level: "hip", focalLengthMm: 35 }),
          framingOf({ size: "full", view: "front", level: "high", focalLengthMm: 35 }),
        ] as [DirectorCameraFraming, DirectorCameraFraming],
      "crane-up",
    ],
    [
      "sinking lens cranes down",
      () =>
        [
          framingOf({ size: "full", view: "front", level: "high", focalLengthMm: 35 }),
          framingOf({ size: "full", view: "front", level: "knee", focalLengthMm: 35 }),
        ] as [DirectorCameraFraming, DirectorCameraFraming],
      "crane-down",
    ],
    [
      // Moving from the subject's right side to its left carries the camera
      // toward its own right while it faces the subject.
      "arcing to the subject's other side orbits",
      () =>
        [
          framingOf({ size: "medium", view: "front-quarter", side: "right", level: "eye" }),
          framingOf({ size: "medium", view: "front-quarter", side: "left", level: "eye" }),
        ] as [DirectorCameraFraming, DirectorCameraFraming],
      "orbit-right",
    ],
  ];

  for (const [name, build, expected] of cases) {
    it(name, () => {
      const [a, b] = build();
      const move = describeDirectorCameraMove(a, b, SUBJECT);
      expect(move.id).toBe(expected);
      expect(move.label).toBeTruthy();
      expect(move.phrase).toBeTruthy();
    });
  }

  it("names a contra-zoom when the dolly and lens fight to hold size", () => {
    const a = framingOf({ size: "medium", view: "front", level: "eye", focalLengthMm: 28 });
    // Pull back while lengthening the lens so the subject's screen size holds.
    const solvedTele = solveDirectorShotFraming(
      { size: "medium", view: "front", level: "eye", focalLengthMm: 85 },
      SUBJECT,
    );
    const b: DirectorCameraFraming = {
      position: solvedTele.position,
      target: solvedTele.target,
      focalLengthMm: solvedTele.focalLengthMm,
    };
    const move = describeDirectorCameraMove(a, b, SUBJECT);
    expect(move.id).toBe("contra-zoom");
    expect(move.phrase).toContain("vertigo");
  });

  it("reports tempo from lens travel per second", () => {
    const a = framingOf({ size: "wide", view: "front", level: "eye", focalLengthMm: 24 });
    const b = framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 24 });
    const slow = describeDirectorCameraMove(a, b, SUBJECT, { durationSeconds: 30 });
    const fast = describeDirectorCameraMove(a, b, SUBJECT, { durationSeconds: 1.2 });
    expect(slow.tempo).toBe("slow");
    expect(fast.tempo).toBe("fast");
    expect(fast.phrase).toContain("fast");
  });

  it("carries both framings' derived language in the description", () => {
    const a = framingOf({ size: "full", view: "front", level: "eye" });
    const b = framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 35 });
    const move = describeDirectorCameraMove(a, b, SUBJECT);
    expect(move.from.size).toBe("full");
    expect(move.to.size).toBe("close-up");
    expect(move.deltas.travel_m).toBeGreaterThan(0);
  });
});

describe("move slate and chained phrase", () => {
  it("formats the burned-in move slate", () => {
    const a = framingOf({ size: "full", view: "front", level: "eye", focalLengthMm: 35 });
    const b = framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 35 });
    const move = describeDirectorCameraMove(a, b, SUBJECT);
    expect(formatDirectorCameraMoveSlate(move)).toBe("FULL 35MM → CLOSE-UP 35MM · PUSH-IN");
  });

  it("chains segment phrases in time order", () => {
    const a = framingOf({ size: "full", view: "front", level: "eye", focalLengthMm: 35 });
    const b = framingOf({ size: "close-up", view: "front", level: "eye", focalLengthMm: 35 });
    const c = framingOf({ size: "close-up", view: "profile", side: "right", level: "eye", focalLengthMm: 35 });
    const first = describeDirectorCameraMove(a, b, SUBJECT);
    const second = describeDirectorCameraMove(b, c, SUBJECT);
    const phrase = buildDirectorCameraMovePhrase([first, second]);
    expect(phrase).toContain(first.phrase);
    expect(phrase).toContain(", then ");
    expect(phrase).toContain(second.phrase);
  });
});
