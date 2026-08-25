using System;
using System.Collections.Generic;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Pure-math C# port of Director's semantic character pose system,
    /// mirrored from packages/project-schema/src/poseSchema.ts and
    /// frontend/director/src/comprehensive/editor/runtime/mixamo/
    /// mixamoCharacterRig.ts (getMixamoPoseBoneRotations). All angles are
    /// produced in radians in glTF/three.js bone-local space; the importer
    /// boundary converts them to Unity bone-local space with
    /// <see cref="GltfLocalQuaternionToUnity"/>. Every constant here is
    /// pinned by the host-free goldens in
    /// packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts
    /// and by DirectorPoseMathTests.cs, so the TypeScript reference and this
    /// port cannot drift silently.
    /// </summary>
    public static class DirectorPoseMath
    {
        /// <summary>Director's static neutral stance lowers a T-pose arm by 70 degrees.</summary>
        public const double NeutralShoulderDegrees = 70.0;

        /// <summary>
        /// Semantic bone roles to Mixamo bone-name aliases (checked in order),
        /// mirrored from mixamoBoneRoleAliases.json. Alias names are matched
        /// after the rig bone prefix is stripped.
        /// </summary>
        public static readonly IReadOnlyDictionary<string, string[]> BoneRoleAliases =
            new Dictionary<string, string[]>
            {
                ["body"] = new[] { "Hips" },
                ["torso"] = new[] { "Spine2", "Spine1", "Spine" },
                ["head"] = new[] { "Head" },
                ["leftShoulder"] = new[] { "LeftArm", "LeftShoulder" },
                ["rightShoulder"] = new[] { "RightArm", "RightShoulder" },
                ["leftElbow"] = new[] { "LeftForeArm", "LeftLowerArm" },
                ["rightElbow"] = new[] { "RightForeArm", "RightLowerArm" },
                ["leftHand"] = new[] { "LeftHand" },
                ["rightHand"] = new[] { "RightHand" },
                ["leftHip"] = new[] { "LeftUpLeg", "LeftUpperLeg" },
                ["rightHip"] = new[] { "RightUpLeg", "RightUpperLeg" },
                ["leftKnee"] = new[] { "LeftLeg", "LeftLowerLeg" },
                ["rightKnee"] = new[] { "RightLeg", "RightLowerLeg" },
                ["leftFoot"] = new[] { "LeftFoot" },
                ["rightFoot"] = new[] { "RightFoot" },
            };

        private static double BodyScale(string bodyType)
        {
            if (bodyType == "chibi") return 58.0 / 90.0;
            if (bodyType == "child") return 72.0 / 90.0;
            return 1.0;
        }

        private static void BaseLimits(string control, out double min, out double max)
        {
            if (control == "body.offsetY")
            {
                min = -1.0;
                max = 1.0;
                return;
            }
            if (control.EndsWith("Elbow.bend", StringComparison.Ordinal) ||
                control.EndsWith("Knee.bend", StringComparison.Ordinal))
            {
                min = 0.0;
                max = 150.0;
                return;
            }
            if (control.EndsWith("Shoulder.pitch", StringComparison.Ordinal) ||
                control.EndsWith("Hip.pitch", StringComparison.Ordinal))
            {
                min = -120.0;
                max = 120.0;
                return;
            }
            min = -90.0;
            max = 90.0;
        }

        /// <summary>
        /// Clamps one pose control value to its valid range, ported from
        /// clampCharacterPoseControlValue: degree limits scale with the child
        /// and chibi body proportions while body.offsetY stays in metres.
        /// </summary>
        public static double ClampControlValue(string control, double value, string bodyType)
        {
            BaseLimits(control, out double min, out double max);
            if (control != "body.offsetY")
            {
                double scale = BodyScale(bodyType);
                min *= scale;
                max *= scale;
            }
            return Math.Min(max, Math.Max(min, value));
        }

        private static double Radians(
            IReadOnlyDictionary<string, double> controls, string control, string bodyType)
        {
            double value = controls != null && controls.TryGetValue(control, out double raw) ? raw : 0.0;
            return ClampControlValue(control, value, bodyType) * Math.PI / 180.0;
        }

        /// <summary>
        /// Maps Director's semantic controls onto standard Mixamo T-pose bone
        /// rotation offsets (XYZ Euler radians in glTF/three.js bone-local
        /// space), ported verbatim from getMixamoPoseBoneRotations. When
        /// <paramref name="animated"/> is true the 70-degree neutral shoulder
        /// stance is skipped, because a sampled clip already lowers the arms.
        /// </summary>
        public static Dictionary<string, double[]> GetMixamoPoseBoneRotations(
            IReadOnlyDictionary<string, double> controls, string bodyType, bool animated)
        {
            double neutralShoulder = animated ? 0.0 : NeutralShoulderDegrees * Math.PI / 180.0;
            return new Dictionary<string, double[]>
            {
                ["body"] = new[]
                {
                    Radians(controls, "body.pitch", bodyType),
                    Radians(controls, "body.yaw", bodyType),
                    Radians(controls, "body.roll", bodyType),
                },
                ["torso"] = new[]
                {
                    Radians(controls, "torso.pitch", bodyType),
                    Radians(controls, "torso.yaw", bodyType),
                    Radians(controls, "torso.roll", bodyType),
                },
                ["head"] = new[]
                {
                    Radians(controls, "head.pitch", bodyType),
                    Radians(controls, "head.yaw", bodyType),
                    Radians(controls, "head.roll", bodyType),
                },
                ["leftShoulder"] = new[]
                {
                    neutralShoulder + Radians(controls, "leftShoulder.spread", bodyType),
                    Radians(controls, "leftShoulder.twist", bodyType),
                    Radians(controls, "leftShoulder.pitch", bodyType),
                },
                ["rightShoulder"] = new[]
                {
                    neutralShoulder - Radians(controls, "rightShoulder.spread", bodyType),
                    Radians(controls, "rightShoulder.twist", bodyType),
                    -Radians(controls, "rightShoulder.pitch", bodyType),
                },
                ["leftElbow"] = new[] { 0.0, 0.0, Radians(controls, "leftElbow.bend", bodyType) },
                ["rightElbow"] = new[] { 0.0, 0.0, -Radians(controls, "rightElbow.bend", bodyType) },
                ["leftHand"] = new[]
                {
                    Radians(controls, "leftHand.pitch", bodyType),
                    Radians(controls, "leftHand.twist", bodyType),
                    Radians(controls, "leftHand.roll", bodyType),
                },
                ["rightHand"] = new[]
                {
                    Radians(controls, "rightHand.pitch", bodyType),
                    Radians(controls, "rightHand.twist", bodyType),
                    Radians(controls, "rightHand.roll", bodyType),
                },
                ["leftHip"] = new[]
                {
                    Radians(controls, "leftHip.pitch", bodyType),
                    Radians(controls, "leftHip.twist", bodyType),
                    -Radians(controls, "leftHip.spread", bodyType),
                },
                ["rightHip"] = new[]
                {
                    Radians(controls, "rightHip.pitch", bodyType),
                    Radians(controls, "rightHip.twist", bodyType),
                    -Radians(controls, "rightHip.spread", bodyType),
                },
                ["leftKnee"] = new[] { -Radians(controls, "leftKnee.bend", bodyType), 0.0, 0.0 },
                ["rightKnee"] = new[] { -Radians(controls, "rightKnee.bend", bodyType), 0.0, 0.0 },
                ["leftFoot"] = new[]
                {
                    Radians(controls, "leftFoot.pitch", bodyType),
                    Radians(controls, "leftFoot.twist", bodyType),
                    Radians(controls, "leftFoot.roll", bodyType),
                },
                ["rightFoot"] = new[]
                {
                    Radians(controls, "rightFoot.pitch", bodyType),
                    Radians(controls, "rightFoot.twist", bodyType),
                    Radians(controls, "rightFoot.roll", bodyType),
                },
            };
        }

        /// <summary>
        /// Converts a bone-local rotation quaternion from glTF/three.js
        /// right-handed space into the space of a Unity glTF import.
        /// glTFast and UnityGLTF both convert glTF's right-handed basis to
        /// Unity's left-handed basis by inverting the X axis, and conjugating
        /// a rotation by that reflection maps quaternion components as
        /// (x, y, z, w) -> (x, -y, -z, w). The map is multiplicative
        /// (C(a·b) = C(a)·C(b)), so offsets composed in three.js space can be
        /// converted after composition or per factor interchangeably.
        /// </summary>
        public static double[] GltfLocalQuaternionToUnity(double x, double y, double z, double w)
        {
            return new[] { x, -y, -z, w };
        }

        /// <summary>Hamilton product a*b for xyzw quaternion arrays.</summary>
        public static double[] MultiplyQuaternions(double[] a, double[] b)
        {
            return new[]
            {
                a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
                a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
                a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
            };
        }
    }
}
