/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  announceDirectorPossessionFeedback,
  formatPossessionAmbiguityNotice,
  formatPossessionFilledTargetsNotice,
  formatPossessionScopeRejectionNotice,
  parsePossessionScopeRejection,
  parsePossessionTargetAmbiguity,
  parsePossessionWriteReceipt,
  possessionReasonLabel,
  possessionReasonRecoveryHint,
  presentDirectorPossessionFeedback,
} from "../../src/agent/possessionWriteReceiptUi";
import {
  clearDirectorNotifications,
  getDirectorNotifications,
} from "../../src/comprehensive/app/notifications/directorNotificationStore";

afterEach(() => {
  clearDirectorNotifications();
});

describe("possession write-depth receipt presentation", () => {
  it("formats filled_targets with action index, field, and filled object id", () => {
    const notice = formatPossessionFilledTargetsNotice({
      session_id: "agent-1",
      possessed_object_ids: ["hero"],
      filled_targets: [
        { index: 0, action: "set_character_motion", field: "object_id", object_id: "hero" },
        { index: 2, action: "set_character_pose_controls", field: "object_id", object_id: "hero" },
      ],
    });
    expect(notice.title).toBe("占有写入已自动填充目标");
    expect(notice.detail).toContain("actions[0] set_character_motion.object_id → hero");
    expect(notice.detail).toContain("actions[2] set_character_pose_controls.object_id → hero");
  });

  it("formats ambiguous omissions with possessed ids and omitted_targets", () => {
    const notice = formatPossessionAmbiguityNotice({
      session_id: "agent-1",
      possessed_object_ids: ["hero", "villain"],
      omitted_targets: [{ index: 0, action: "set_character_motion", field: "object_id" }],
    });
    expect(notice.title).toBe("占有目标不明确，无法自动填充");
    expect(notice.detail).toContain("已占有：hero, villain");
    expect(notice.detail).toContain("actions[0] set_character_motion.object_id");
  });

  it("formats scope rejection with possessed ids, operation, zh reason label, and recovery hint", () => {
    const notice = formatPossessionScopeRejectionNotice({
      session_id: "agent-1",
      possessed_object_ids: ["hero"],
      operation: "author",
      reason: "target_not_possessed",
      action: "set_character_motion",
      target_id: "villain",
    });
    expect(notice.title).toBe("占有范围拒绝写入");
    expect(notice.detail).toContain("已占有：hero");
    expect(notice.detail).toContain("操作：author");
    expect(notice.detail).toContain("原因：目标不在占有范围内");
    expect(notice.detail).toContain("动作：set_character_motion");
    expect(notice.detail).toContain("目标：villain");
    expect(notice.detail).toContain("建议：");
    expect(notice.detail).not.toContain("reason=target_not_possessed");
    expect(possessionReasonLabel("target_not_possessed")).toBe("目标不在占有范围内");
    expect(possessionReasonRecoveryHint("target_not_possessed")).toContain("possessed_object_ids");
    expect(possessionReasonLabel("not_a_possession_reason")).toBeNull();
  });

  it("parses gateway possession payloads and presents the matching notice", () => {
    expect(
      parsePossessionWriteReceipt({
        session_id: "s",
        possessed_object_ids: ["hero"],
        filled_targets: [{ index: 0, action: "set_character_ik", field: "object_id", object_id: "hero" }],
      })?.filled_targets[0]?.object_id,
    ).toBe("hero");
    expect(
      parsePossessionTargetAmbiguity({
        session_id: "s",
        possessed_object_ids: ["a", "b"],
        omitted_targets: [{ index: 1, action: "focus_objects", field: "object_ids" }],
      })?.omitted_targets[0]?.field,
    ).toBe("object_ids");
    expect(
      parsePossessionScopeRejection({
        session_id: "s",
        possessed_object_ids: ["hero"],
        operation: "reconstruction.apply",
        reason: "stage_wide_mutation",
      })?.reason,
    ).toBe("stage_wide_mutation");

    expect(
      presentDirectorPossessionFeedback({
        possession: {
          session_id: "s",
          possessed_object_ids: ["hero"],
          filled_targets: [{ index: 0, action: "set_character_motion", field: "object_id", object_id: "hero" }],
        },
      })?.severity,
    ).toBe("info");
    expect(
      presentDirectorPossessionFeedback({
        code: "possession_target_ambiguous",
        possession: {
          session_id: "s",
          possessed_object_ids: ["hero", "villain"],
          omitted_targets: [{ index: 0, action: "set_character_motion", field: "object_id" }],
        },
      })?.severity,
    ).toBe("warning");
  });

  it("announces possession feedback through the Director notification layer", () => {
    expect(
      announceDirectorPossessionFeedback({
        possession: {
          session_id: "agent-1",
          possessed_object_ids: ["hero"],
          filled_targets: [{ index: 0, action: "set_character_motion", field: "object_id", object_id: "hero" }],
        },
      }),
    ).toBe(true);
    const notices = getDirectorNotifications();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("占有写入已自动填充目标");
    expect(notices[0]?.detail).toContain("actions[0] set_character_motion.object_id → hero");
    expect(notices[0]?.severity).toBe("info");
  });
});
