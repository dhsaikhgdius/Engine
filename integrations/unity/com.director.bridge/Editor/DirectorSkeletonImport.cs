using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Skeleton and Avatar construction for skinned Director characters.
    ///
    /// Characters resolve strictly through their assetRefId (never by array
    /// index); the exchange manifest's characterMetadata declares the rig type
    /// and bone prefix. Mixamo-compatible rigs build a Unity Humanoid Avatar
    /// from the fixed Mixamo-to-HumanTrait bone map below; rigs that lack the
    /// required humanoid bones fall back to a Generic Avatar so Timeline
    /// animation still binds. Both outcomes attach an Animator to the
    /// character instance and persist the Avatar asset next to the imported
    /// GLB. Pose controls and IK targets are Director-side systems and
    /// warn-and-omit; the character imports in its authored bind pose.
    /// </summary>
    public static class DirectorSkeletonImport
    {
        /// <summary>The avatar kind that was built for one character instance.</summary>
        public enum AvatarKind
        {
            None,
            Humanoid,
            Generic,
        }

        /// <summary>
        /// Mixamo bone name (without prefix) to Unity HumanTrait bone name.
        /// Only bones with an exact 1:1 humanoid equivalent are mapped; end
        /// markers (HeadTop_End, Toe_End, Thumb4/Index4/... tips) stay
        /// skeleton-only.
        /// </summary>
        private static readonly IReadOnlyDictionary<string, string> MixamoToHumanTrait =
            new Dictionary<string, string>
            {
                ["Hips"] = "Hips",
                ["Spine"] = "Spine",
                ["Spine1"] = "Chest",
                ["Spine2"] = "UpperChest",
                ["Neck"] = "Neck",
                ["Head"] = "Head",
                ["LeftShoulder"] = "LeftShoulder",
                ["LeftArm"] = "LeftUpperArm",
                ["LeftForeArm"] = "LeftLowerArm",
                ["LeftHand"] = "LeftHand",
                ["RightShoulder"] = "RightShoulder",
                ["RightArm"] = "RightUpperArm",
                ["RightForeArm"] = "RightLowerArm",
                ["RightHand"] = "RightHand",
                ["LeftUpLeg"] = "LeftUpperLeg",
                ["LeftLeg"] = "LeftLowerLeg",
                ["LeftFoot"] = "LeftFoot",
                ["LeftToeBase"] = "LeftToes",
                ["RightUpLeg"] = "RightUpperLeg",
                ["RightLeg"] = "RightLowerLeg",
                ["RightFoot"] = "RightFoot",
                ["RightToeBase"] = "RightToes",
                ["LeftHandThumb1"] = "Left Thumb Proximal",
                ["LeftHandThumb2"] = "Left Thumb Intermediate",
                ["LeftHandThumb3"] = "Left Thumb Distal",
                ["LeftHandIndex1"] = "Left Index Proximal",
                ["LeftHandIndex2"] = "Left Index Intermediate",
                ["LeftHandIndex3"] = "Left Index Distal",
                ["LeftHandMiddle1"] = "Left Middle Proximal",
                ["LeftHandMiddle2"] = "Left Middle Intermediate",
                ["LeftHandMiddle3"] = "Left Middle Distal",
                ["LeftHandRing1"] = "Left Ring Proximal",
                ["LeftHandRing2"] = "Left Ring Intermediate",
                ["LeftHandRing3"] = "Left Ring Distal",
                ["LeftHandPinky1"] = "Left Little Proximal",
                ["LeftHandPinky2"] = "Left Little Intermediate",
                ["LeftHandPinky3"] = "Left Little Distal",
                ["RightHandThumb1"] = "Right Thumb Proximal",
                ["RightHandThumb2"] = "Right Thumb Intermediate",
                ["RightHandThumb3"] = "Right Thumb Distal",
                ["RightHandIndex1"] = "Right Index Proximal",
                ["RightHandIndex2"] = "Right Index Intermediate",
                ["RightHandIndex3"] = "Right Index Distal",
                ["RightHandMiddle1"] = "Right Middle Proximal",
                ["RightHandMiddle2"] = "Right Middle Intermediate",
                ["RightHandMiddle3"] = "Right Middle Distal",
                ["RightHandRing1"] = "Right Ring Proximal",
                ["RightHandRing2"] = "Right Ring Intermediate",
                ["RightHandRing3"] = "Right Ring Distal",
                ["RightHandPinky1"] = "Right Little Proximal",
                ["RightHandPinky2"] = "Right Little Intermediate",
                ["RightHandPinky3"] = "Right Little Distal",
            };

        /// <summary>Humanoid bones Unity requires before BuildHumanAvatar succeeds.</summary>
        private static readonly string[] RequiredHumanBones =
        {
            "Hips", "Spine", "Head",
            "LeftUpperArm", "LeftLowerArm", "LeftHand",
            "RightUpperArm", "RightLowerArm", "RightHand",
            "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
            "RightUpperLeg", "RightLowerLeg", "RightFoot",
        };

        /// <summary>
        /// Builds an Avatar for one skinned character instance and attaches an
        /// Animator. The characterMetadata comes from the manifest asset entry
        /// resolved by assetRefId.
        /// </summary>
        public static AvatarKind BuildAvatar(
            GameObject instanceRoot,
            JObject characterMetadata,
            string directorId,
            string avatarAssetFolder,
            List<string> warnings)
        {
            if (instanceRoot.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length == 0)
            {
                return AvatarKind.None;
            }

            string rigType = (string)characterMetadata?["rig"]?["type"];
            string bonePrefix = (string)characterMetadata?["rig"]?["bonePrefix"] ?? "mixamorig:";
            Avatar avatar = null;
            AvatarKind kind = AvatarKind.None;

            if (rigType == "mixamo")
            {
                avatar = TryBuildHumanoidAvatar(instanceRoot, bonePrefix, directorId, warnings);
                kind = avatar != null ? AvatarKind.Humanoid : AvatarKind.None;
            }
            else if (rigType != null)
            {
                warnings.Add(
                    $"Character {directorId}: rig type \"{rigType}\" has no Director humanoid mapping; " +
                    "built a Generic Avatar.");
            }

            if (avatar == null)
            {
                avatar = AvatarBuilder.BuildGenericAvatar(instanceRoot, string.Empty);
                kind = AvatarKind.Generic;
            }
            if (avatar == null || !avatar.isValid)
            {
                warnings.Add($"Character {directorId}: Unity could not build a valid Avatar; skipped (warn-and-omit).");
                return AvatarKind.None;
            }

            avatar.name = $"{DirectorGlbImport.SafeFileStem(directorId)}-avatar";
            System.IO.Directory.CreateDirectory(avatarAssetFolder);
            AssetDatabase.CreateAsset(avatar, $"{avatarAssetFolder}/{avatar.name}.asset");

            Animator animator = instanceRoot.GetComponent<Animator>();
            if (animator == null)
            {
                animator = instanceRoot.AddComponent<Animator>();
            }
            animator.avatar = avatar;
            return kind;
        }

        private static Avatar TryBuildHumanoidAvatar(
            GameObject instanceRoot, string bonePrefix, string directorId, List<string> warnings)
        {
            Transform[] skeleton = instanceRoot.GetComponentsInChildren<Transform>(true);
            var humanBones = new List<HumanBone>();
            var mappedHumanNames = new HashSet<string>();
            foreach (Transform bone in skeleton)
            {
                string mixamoName = StripBonePrefix(bone.name, bonePrefix);
                if (mixamoName == null || !MixamoToHumanTrait.TryGetValue(mixamoName, out string humanName))
                {
                    continue;
                }
                if (!mappedHumanNames.Add(humanName))
                {
                    warnings.Add(
                        $"Character {directorId}: duplicate candidate for humanoid bone {humanName} " +
                        $"({bone.name}); kept the first match.");
                    continue;
                }
                humanBones.Add(new HumanBone
                {
                    boneName = bone.name,
                    humanName = humanName,
                    limit = new HumanLimit { useDefaultValues = true },
                });
            }

            string[] missing = RequiredHumanBones.Where(required => !mappedHumanNames.Contains(required)).ToArray();
            if (missing.Length > 0)
            {
                warnings.Add(
                    $"Character {directorId}: Mixamo rig is missing required humanoid bones " +
                    $"({string.Join(", ", missing)}); fell back to a Generic Avatar.");
                return null;
            }

            var description = new HumanDescription
            {
                human = humanBones.ToArray(),
                skeleton = skeleton
                    .Select(bone => new SkeletonBone
                    {
                        name = bone.name,
                        position = bone.localPosition,
                        rotation = bone.localRotation,
                        scale = bone.localScale,
                    })
                    .ToArray(),
                upperArmTwist = 0.5f,
                lowerArmTwist = 0.5f,
                upperLegTwist = 0.5f,
                lowerLegTwist = 0.5f,
                armStretch = 0.05f,
                legStretch = 0.05f,
                feetSpacing = 0f,
                hasTranslationDoF = false,
            };
            Avatar avatar = AvatarBuilder.BuildHumanAvatar(instanceRoot, description);
            if (avatar == null || !avatar.isValid || !avatar.isHuman)
            {
                warnings.Add(
                    $"Character {directorId}: humanoid Avatar validation failed (typically a non-T-pose bind); " +
                    "fell back to a Generic Avatar.");
                return null;
            }
            return avatar;
        }

        /// <summary>
        /// Strips the rig bone prefix, tolerating importers that replace the
        /// ':' separator with '_' when sanitizing node names.
        /// </summary>
        public static string StripBonePrefix(string boneName, string bonePrefix)
        {
            if (boneName.StartsWith(bonePrefix, StringComparison.Ordinal))
            {
                return boneName.Substring(bonePrefix.Length);
            }
            if (bonePrefix.EndsWith(":", StringComparison.Ordinal))
            {
                string sanitized = bonePrefix.Substring(0, bonePrefix.Length - 1) + "_";
                if (boneName.StartsWith(sanitized, StringComparison.Ordinal))
                {
                    return boneName.Substring(sanitized.Length);
                }
            }
            return null;
        }

        /// <summary>
        /// Warns about Director-side character systems that do not transfer:
        /// pose controls, IK targets, and motion playback state.
        /// </summary>
        public static void WarnUntransferredRigState(JObject entity, List<string> warnings)
        {
            var characterRig = (JObject)entity["characterRig"];
            if (characterRig == null)
            {
                return;
            }
            string directorId = (string)entity["id"];
            var controls = (JObject)characterRig["controls"];
            if ((controls != null && controls.Count > 0) || characterRig["posePresetId"]?.Type == JTokenType.String)
            {
                warnings.Add(
                    $"Character {directorId}: Director pose controls are evaluated Director-side; the character " +
                    "imports in its bind pose (warn-and-omit).");
            }
            if (characterRig["ik"] != null)
            {
                warnings.Add(
                    $"Character {directorId}: Director IK targets are evaluated Director-side; omitted (warn-and-omit).");
            }
            if (characterRig["motion"] != null)
            {
                warnings.Add(
                    $"Character {directorId}: Director motion clip playback ({(string)characterRig["motion"]?["clipId"]}) " +
                    "is not baked; assign the clip in Unity if needed (warn-and-omit).");
            }
        }
    }
}
