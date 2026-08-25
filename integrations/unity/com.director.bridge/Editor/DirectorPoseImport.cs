using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Applies Director semantic pose controls to imported Mixamo-compatible
    /// character instances and bakes keyframed pose channels into
    /// AnimationClips.
    ///
    /// Static controls (characterRig.controls) pose the imported skeleton
    /// once, after the Avatar is built from the untouched bind pose.
    /// Keyframed pose channels bake through <see cref="PoseBaker"/>:
    /// Humanoid avatars sample Unity's own retargeting via HumanPoseHandler
    /// into muscle + RootT/RootQ curves, Generic avatars bake per-bone
    /// localRotation curves. Rotation offsets are computed in glTF/three.js
    /// bone-local space by DirectorPoseMath and converted at this boundary
    /// with the X-axis-inversion conjugation used by Unity glTF importers
    /// (glTFast, UnityGLTF).
    ///
    /// Channels that cannot bake (pose controls on non-Mixamo rigs or
    /// unresolvable skeletons, skeletal motion blocks, procedural gait, IK
    /// goals) are recorded as structured omissions via
    /// <see cref="AddOmission"/> so the run report never drops them silently.
    /// </summary>
    public static class DirectorPoseImport
    {
        /// <summary>A character instance with resolved semantic bones and captured rest pose.</summary>
        public sealed class ResolvedRig
        {
            public GameObject Root;
            public string BodyType;
            public Dictionary<string, Transform> BonesByRole;
            public Dictionary<string, Quaternion> RestLocalRotationByRole;
            public Vector3 HipsRestLocalPosition;
        }

        private static readonly Dictionary<GameObject, ResolvedRig> RigCache =
            new Dictionary<GameObject, ResolvedRig>();

        /// <summary>
        /// Appends one structured warn-and-omit record plus its human-readable
        /// warning, matching directorDccUnityOmittedChannelSchema.
        /// </summary>
        public static void AddOmission(
            JArray omissions, List<string> warnings, string directorId, string channel, string reason)
        {
            omissions.Add(new JObject
            {
                ["directorId"] = directorId,
                ["channel"] = channel,
                ["reason"] = reason,
            });
            warnings.Add($"Entity {directorId}: channel \"{channel}\" was omitted. {reason}");
        }

        private static string RigBonePrefix(JObject characterMetadata)
        {
            return (string)characterMetadata?["rig"]?["bonePrefix"] ?? "mixamorig:";
        }

        /// <summary>
        /// Whether this entity's pose controls target a Mixamo-compatible rig
        /// (per the project characterRig or the asset characterMetadata).
        /// </summary>
        public static bool IsMixamoPoseRig(JObject entity, JObject characterMetadata)
        {
            string projectRigType = (string)entity?["characterRig"]?["rigType"];
            string assetRigType = (string)characterMetadata?["rig"]?["type"];
            return projectRigType == "mixamo" || assetRigType == "mixamo";
        }

        /// <summary>Base pose controls from characterRig.controls, or an empty dictionary.</summary>
        public static Dictionary<string, double> BaseControls(JObject entity)
        {
            var controls = new Dictionary<string, double>();
            if (entity?["characterRig"]?["controls"] is JObject controlValues)
            {
                foreach (KeyValuePair<string, JToken> control in controlValues)
                {
                    controls[control.Key] = (double)control.Value;
                }
            }
            return controls;
        }

        /// <summary>
        /// Resolves the semantic bone roles on a character instance and
        /// captures its rest pose. The first resolution wins and is cached so
        /// the rest pose stays the authored bind pose even after a static
        /// pose was applied; call this before posing the instance.
        /// </summary>
        public static ResolvedRig ResolveRig(GameObject root, JObject entity, JObject characterMetadata)
        {
            if (RigCache.TryGetValue(root, out ResolvedRig cached)) return cached;
            string bonePrefix = RigBonePrefix(characterMetadata);
            var byStrippedName = new Dictionary<string, Transform>();
            foreach (Transform bone in root.GetComponentsInChildren<Transform>(true))
            {
                string stripped = DirectorSkeletonImport.StripBonePrefix(bone.name, bonePrefix);
                if (stripped != null && !byStrippedName.ContainsKey(stripped))
                {
                    byStrippedName[stripped] = bone;
                }
            }

            var bonesByRole = new Dictionary<string, Transform>();
            var restByRole = new Dictionary<string, Quaternion>();
            foreach (KeyValuePair<string, string[]> role in DirectorPoseMath.BoneRoleAliases)
            {
                Transform bone = role.Value
                    .Select(alias => byStrippedName.TryGetValue(alias, out Transform match) ? match : null)
                    .FirstOrDefault(match => match != null);
                if (bone == null) continue;
                bonesByRole[role.Key] = bone;
                restByRole[role.Key] = bone.localRotation;
            }

            var rig = new ResolvedRig
            {
                Root = root,
                BodyType = (string)entity?["bodyType"],
                BonesByRole = bonesByRole,
                RestLocalRotationByRole = restByRole,
                HipsRestLocalPosition = bonesByRole.TryGetValue("body", out Transform hips)
                    ? hips.localPosition
                    : Vector3.zero,
            };
            RigCache[root] = rig;
            return rig;
        }

        private static Quaternion OffsetToUnity(double[] eulerXyz)
        {
            double[] gltf = DirectorSpace.QuaternionFromEulerXyz(eulerXyz[0], eulerXyz[1], eulerXyz[2]);
            double[] unity = DirectorPoseMath.GltfLocalQuaternionToUnity(gltf[0], gltf[1], gltf[2], gltf[3]);
            var quaternion = new Quaternion((float)unity[0], (float)unity[1], (float)unity[2], (float)unity[3]);
            quaternion.Normalize();
            return quaternion;
        }

        /// <summary>
        /// Poses the resolved skeleton from control values: each semantic
        /// bone becomes rest * offset (matching applyMixamoRigLayers), and
        /// body.offsetY translates the hips by an entity-local metre offset
        /// converted into the hips parent's local axes.
        /// </summary>
        public static void ApplyControlOffsets(ResolvedRig rig, IReadOnlyDictionary<string, double> controls)
        {
            Dictionary<string, double[]> rotations =
                DirectorPoseMath.GetMixamoPoseBoneRotations(controls, rig.BodyType, animated: false);
            foreach (KeyValuePair<string, Transform> bone in rig.BonesByRole)
            {
                Quaternion rest = rig.RestLocalRotationByRole[bone.Key];
                bone.Value.localRotation = rotations.TryGetValue(bone.Key, out double[] eulerXyz)
                    ? rest * OffsetToUnity(eulerXyz)
                    : rest;
            }
            if (rig.BonesByRole.TryGetValue("body", out Transform hips))
            {
                double offsetY = controls != null && controls.TryGetValue("body.offsetY", out double value)
                    ? DirectorPoseMath.ClampControlValue("body.offsetY", value, rig.BodyType)
                    : 0.0;
                Vector3 localPosition = rig.HipsRestLocalPosition;
                if (offsetY != 0.0 && hips.parent != null)
                {
                    localPosition += hips.parent.InverseTransformVector(
                        rig.Root.transform.TransformVector(new Vector3(0f, (float)offsetY, 0f)));
                }
                hips.localPosition = localPosition;
            }
        }

        /// <summary>Restores the captured rest pose on every resolved bone.</summary>
        public static void RestoreRestPose(ResolvedRig rig)
        {
            foreach (KeyValuePair<string, Transform> bone in rig.BonesByRole)
            {
                bone.Value.localRotation = rig.RestLocalRotationByRole[bone.Key];
            }
            if (rig.BonesByRole.TryGetValue("body", out Transform hips))
            {
                hips.localPosition = rig.HipsRestLocalPosition;
            }
        }

        /// <summary>
        /// Applies the static characterRig.controls pose to one imported
        /// character (after its Avatar was built from the bind pose).
        /// Non-Mixamo rigs and unresolvable skeletons record a structured
        /// poseValues omission instead.
        /// </summary>
        public static bool ApplyStaticPose(
            JObject entity,
            GameObject root,
            JObject characterMetadata,
            List<string> warnings,
            JArray omissions)
        {
            var characterRig = (JObject)entity["characterRig"];
            if (characterRig == null) return false;
            string directorId = (string)entity["id"];
            Dictionary<string, double> controls = BaseControls(entity);
            bool hasPoseState = controls.Count > 0 || characterRig["posePresetId"]?.Type == JTokenType.String;
            if (!hasPoseState) return false;

            if (!IsMixamoPoseRig(entity, characterMetadata))
            {
                AddOmission(
                    omissions, warnings, directorId, "poseValues",
                    $"Pose controls target rig type \"{(string)characterRig["rigType"]}\", which has no Unity " +
                    "bone mapping; the character keeps its bind pose.");
                return false;
            }
            ResolvedRig rig = ResolveRig(root, entity, characterMetadata);
            if (rig.BonesByRole.Count == 0)
            {
                AddOmission(
                    omissions, warnings, directorId, "poseValues",
                    "No Mixamo-compatible bones could be resolved on the imported skeleton; the character keeps " +
                    "its bind pose.");
                return false;
            }
            ApplyControlOffsets(rig, controls);
            return true;
        }

        /// <summary>
        /// Records structured omissions for Director-side character systems
        /// this connector does not bake: IK goals and motion clip playback
        /// (the packaged skeletal clips are not part of the exchange package).
        /// </summary>
        public static void RecordUnbakedRigState(JObject entity, List<string> warnings, JArray omissions)
        {
            var characterRig = (JObject)entity["characterRig"];
            if (characterRig == null) return;
            string directorId = (string)entity["id"];
            if (characterRig["ik"] != null)
            {
                AddOmission(
                    omissions, warnings, directorId, "ik",
                    "Director two-bone IK goals are evaluated Director-side and are not ported to the connector.");
            }
            if (characterRig["motion"] != null)
            {
                AddOmission(
                    omissions, warnings, directorId, "motionBlocks",
                    $"Motion clip playback ({(string)characterRig["motion"]?["clipId"]}) is not baked: the packaged " +
                    "skeletal clip GLBs are not part of the exchange package. Assign the clip in Unity if needed.");
            }
        }

        /// <summary>
        /// Creates a pose baker for one animated entity, or null when the
        /// animation has no pose channels. Unbakeable pose channels record a
        /// structured omission and also return null.
        /// </summary>
        public static PoseBaker TryCreatePoseBaker(
            JObject entity,
            DirectorAnimationEvaluator evaluator,
            GameObject root,
            JObject characterMetadata,
            List<string> warnings,
            JArray omissions)
        {
            if (!evaluator.HasPoseChannels) return null;
            string directorId = (string)entity["id"];
            if (!IsMixamoPoseRig(entity, characterMetadata))
            {
                AddOmission(
                    omissions, warnings, directorId, "poseValues",
                    "Keyframed pose values target a rig without a Unity bone mapping and were not baked.");
                return null;
            }
            ResolvedRig rig = ResolveRig(root, entity, characterMetadata);
            if (rig.BonesByRole.Count == 0)
            {
                AddOmission(
                    omissions, warnings, directorId, "poseValues",
                    "Keyframed pose values could not resolve Mixamo-compatible bones and were not baked.");
                return null;
            }
            return new PoseBaker(rig, evaluator, BaseControls(entity));
        }

        /// <summary>
        /// Bakes evaluated pose controls into clip curves. Humanoid avatars
        /// sample muscle + RootT/RootQ curves through HumanPoseHandler so the
        /// clip drives Unity's own retargeting; Generic avatars bake per-bone
        /// localRotation (and hips localPosition) transform curves.
        /// </summary>
        public sealed class PoseBaker
        {
            private readonly ResolvedRig _rig;
            private readonly DirectorAnimationEvaluator _evaluator;
            private readonly Dictionary<string, double> _baseControls;
            private readonly HumanPoseHandler _humanPoseHandler;
            private readonly int[] _muscleIndices;
            private readonly List<Keyframe>[] _muscleCurves;
            private readonly List<Keyframe>[] _rootT = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private readonly List<Keyframe>[] _rootQ = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private readonly Dictionary<string, List<Keyframe>[]> _boneRotationCurves =
                new Dictionary<string, List<Keyframe>[]>();
            private readonly List<Keyframe>[] _hipsPosition = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private HumanPose _humanPose;

            internal PoseBaker(
                ResolvedRig rig, DirectorAnimationEvaluator evaluator, Dictionary<string, double> baseControls)
            {
                _rig = rig;
                _evaluator = evaluator;
                _baseControls = baseControls;
                Animator animator = rig.Root.GetComponent<Animator>();
                if (animator != null && animator.avatar != null && animator.avatar.isValid && animator.isHuman)
                {
                    _humanPoseHandler = new HumanPoseHandler(animator.avatar, rig.Root.transform);
                    // Director pose controls never reach the fingers, and
                    // finger muscle bindings use a different property-name
                    // grammar; keep the clip to body/limb/head muscles.
                    _muscleIndices = Enumerable.Range(0, HumanTrait.MuscleCount)
                        .Where(index => !IsFingerMuscle(HumanTrait.MuscleName[index]))
                        .ToArray();
                    _muscleCurves = _muscleIndices.Select(_ => new List<Keyframe>()).ToArray();
                }
            }

            private static bool IsFingerMuscle(string muscleName)
            {
                return muscleName.Contains("Thumb") || muscleName.Contains("Index") ||
                    muscleName.Contains("Middle") || muscleName.Contains("Ring") ||
                    muscleName.Contains("Little");
            }

            /// <summary>Samples the pose at one Director frame and appends clip keys.</summary>
            public void AddFrame(float time, double frame)
            {
                Dictionary<string, double> controls = _evaluator.EvaluatePoseValues(frame, _baseControls);
                ApplyControlOffsets(_rig, controls);
                if (_humanPoseHandler != null)
                {
                    _humanPoseHandler.GetHumanPose(ref _humanPose);
                    _rootT[0].Add(new Keyframe(time, _humanPose.bodyPosition.x));
                    _rootT[1].Add(new Keyframe(time, _humanPose.bodyPosition.y));
                    _rootT[2].Add(new Keyframe(time, _humanPose.bodyPosition.z));
                    _rootQ[0].Add(new Keyframe(time, _humanPose.bodyRotation.x));
                    _rootQ[1].Add(new Keyframe(time, _humanPose.bodyRotation.y));
                    _rootQ[2].Add(new Keyframe(time, _humanPose.bodyRotation.z));
                    _rootQ[3].Add(new Keyframe(time, _humanPose.bodyRotation.w));
                    for (int index = 0; index < _muscleIndices.Length; index += 1)
                    {
                        _muscleCurves[index].Add(new Keyframe(time, _humanPose.muscles[_muscleIndices[index]]));
                    }
                    return;
                }
                foreach (KeyValuePair<string, Transform> bone in _rig.BonesByRole)
                {
                    string path = AnimationUtility.CalculateTransformPath(bone.Value, _rig.Root.transform);
                    if (!_boneRotationCurves.TryGetValue(path, out List<Keyframe>[] curves))
                    {
                        curves = new[]
                        {
                            new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>(),
                        };
                        _boneRotationCurves[path] = curves;
                    }
                    Quaternion rotation = bone.Value.localRotation;
                    // Keep each bone's quaternion track on one cover of rotation space.
                    if (curves[3].Count > 0)
                    {
                        List<Keyframe>[] previous = curves;
                        float dot = previous[0][previous[0].Count - 1].value * rotation.x +
                            previous[1][previous[1].Count - 1].value * rotation.y +
                            previous[2][previous[2].Count - 1].value * rotation.z +
                            previous[3][previous[3].Count - 1].value * rotation.w;
                        if (dot < 0f)
                        {
                            rotation = new Quaternion(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
                        }
                    }
                    curves[0].Add(new Keyframe(time, rotation.x));
                    curves[1].Add(new Keyframe(time, rotation.y));
                    curves[2].Add(new Keyframe(time, rotation.z));
                    curves[3].Add(new Keyframe(time, rotation.w));
                }
                if (_rig.BonesByRole.TryGetValue("body", out Transform hips))
                {
                    _hipsPosition[0].Add(new Keyframe(time, hips.localPosition.x));
                    _hipsPosition[1].Add(new Keyframe(time, hips.localPosition.y));
                    _hipsPosition[2].Add(new Keyframe(time, hips.localPosition.z));
                }
            }

            /// <summary>Writes the accumulated pose curves into the clip. Returns the curve count.</summary>
            public int WriteInto(AnimationClip clip)
            {
                int curveCount = 0;
                if (_humanPoseHandler != null)
                {
                    string[] rootTProperties = { "RootT.x", "RootT.y", "RootT.z" };
                    string[] rootQProperties = { "RootQ.x", "RootQ.y", "RootQ.z", "RootQ.w" };
                    for (int index = 0; index < 3; index += 1)
                    {
                        clip.SetCurve(
                            string.Empty, typeof(Animator), rootTProperties[index],
                            new AnimationCurve(_rootT[index].ToArray()));
                        curveCount += 1;
                    }
                    for (int index = 0; index < 4; index += 1)
                    {
                        clip.SetCurve(
                            string.Empty, typeof(Animator), rootQProperties[index],
                            new AnimationCurve(_rootQ[index].ToArray()));
                        curveCount += 1;
                    }
                    for (int index = 0; index < _muscleIndices.Length; index += 1)
                    {
                        clip.SetCurve(
                            string.Empty, typeof(Animator), HumanTrait.MuscleName[_muscleIndices[index]],
                            new AnimationCurve(_muscleCurves[index].ToArray()));
                        curveCount += 1;
                    }
                    return curveCount;
                }
                string[] rotationProperties =
                {
                    "localRotation.x", "localRotation.y", "localRotation.z", "localRotation.w",
                };
                foreach (KeyValuePair<string, List<Keyframe>[]> bone in _boneRotationCurves)
                {
                    for (int index = 0; index < 4; index += 1)
                    {
                        clip.SetCurve(
                            bone.Key, typeof(Transform), rotationProperties[index],
                            new AnimationCurve(bone.Value[index].ToArray()));
                        curveCount += 1;
                    }
                }
                if (_hipsPosition[0].Count > 0 && _rig.BonesByRole.TryGetValue("body", out Transform hips))
                {
                    string hipsPath = AnimationUtility.CalculateTransformPath(hips, _rig.Root.transform);
                    string[] positionProperties = { "localPosition.x", "localPosition.y", "localPosition.z" };
                    for (int index = 0; index < 3; index += 1)
                    {
                        clip.SetCurve(
                            hipsPath, typeof(Transform), positionProperties[index],
                            new AnimationCurve(_hipsPosition[index].ToArray()));
                        curveCount += 1;
                    }
                }
                return curveCount;
            }

            /// <summary>
            /// Pins the evaluated pose at one frame onto the scene skeleton:
            /// a single-frame pose animation poses statically instead of
            /// baking a clip, matching how Director pins single keys.
            /// </summary>
            public void PinStaticPose(double frame)
            {
                ApplyControlOffsets(_rig, _evaluator.EvaluatePoseValues(frame, _baseControls));
                _humanPoseHandler?.Dispose();
            }

            /// <summary>
            /// Restores the scene skeleton after baking: back to the static
            /// base-control pose so the saved scene matches Director's static
            /// look, and releases the HumanPoseHandler.
            /// </summary>
            public void FinishBake()
            {
                RestoreRestPose(_rig);
                if (_baseControls.Count > 0)
                {
                    ApplyControlOffsets(_rig, _baseControls);
                }
                _humanPoseHandler?.Dispose();
            }
        }
    }
}
