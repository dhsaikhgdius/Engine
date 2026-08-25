using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Director.Bridge.Editor.Tests
{
    /// <summary>
    /// Golden tests for the semantic pose math port. Every golden value in
    /// this file was produced by the TypeScript reference implementations
    /// (poseSchema.ts, mixamoCharacterRig.ts, directorAnimation.ts) and the
    /// same tables are asserted in
    /// packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts and
    /// frontend/director/tests/comprehensive/editor/runtime/mixamo/
    /// mixamoUnityConnectorGolden.test.ts.
    /// </summary>
    public class DirectorPoseMathTests
    {
        private const double Tolerance = 1e-9;

        /// <summary>The pose controls exercised by the golden table (clamping included).</summary>
        private static Dictionary<string, double> GoldenControls()
        {
            return new Dictionary<string, double>
            {
                ["body.pitch"] = 10,
                ["body.yaw"] = -20,
                ["torso.roll"] = 15,
                ["head.pitch"] = -25,
                ["leftShoulder.spread"] = 40,
                ["leftShoulder.twist"] = 10,
                ["leftShoulder.pitch"] = -130,
                ["rightShoulder.spread"] = 25,
                ["rightShoulder.pitch"] = 45,
                ["leftElbow.bend"] = 160,
                ["rightElbow.bend"] = 30,
                ["leftHand.roll"] = 15,
                ["leftHip.pitch"] = -30,
                ["leftHip.spread"] = 12,
                ["rightHip.twist"] = -18,
                ["leftKnee.bend"] = 60,
                ["rightKnee.bend"] = 45,
                ["leftFoot.pitch"] = -20,
                ["rightFoot.roll"] = 10,
            };
        }

        private static void AssertVector(double[] actual, double[] expected, string label)
        {
            Assert.That(actual.Length, Is.EqualTo(expected.Length), label);
            for (int index = 0; index < expected.Length; index += 1)
            {
                Assert.That(actual[index], Is.EqualTo(expected[index]).Within(Tolerance), $"{label}[{index}]");
            }
        }

        [Test]
        public void ClampControlValuesMatchTheGoldenTable()
        {
            // control, value, bodyType, expected — mirrored in
            // directorDccUnityConnectorGolden.test.ts.
            (string Control, double Value, string BodyType, double Expected)[] golden =
            {
                ("torso.pitch", 100, null, 90),
                ("leftShoulder.pitch", -130, null, -120),
                ("leftElbow.bend", 160, null, 150),
                ("rightElbow.bend", -10, null, 0),
                ("body.offsetY", 2, "chibi", 1),
                ("head.yaw", 80, "child", 72),
                ("leftKnee.bend", 140, "chibi", 96.666666666667),
                ("rightHip.pitch", -100, "child", -96),
            };
            foreach ((string control, double value, string bodyType, double expected) in golden)
            {
                Assert.That(
                    DirectorPoseMath.ClampControlValue(control, value, bodyType),
                    Is.EqualTo(expected).Within(Tolerance), $"{control} {value} {bodyType ?? "default"}");
            }
        }

        [Test]
        public void BoneRoleAliasesMatchTheDirectorTable()
        {
            // Mirrored from mixamoBoneRoleAliases.json and pinned by
            // mixamoUnityConnectorGolden.test.ts.
            Assert.That(DirectorPoseMath.BoneRoleAliases.Count, Is.EqualTo(15));
            Assert.That(DirectorPoseMath.BoneRoleAliases["body"], Is.EqualTo(new[] { "Hips" }));
            Assert.That(DirectorPoseMath.BoneRoleAliases["torso"], Is.EqualTo(new[] { "Spine2", "Spine1", "Spine" }));
            Assert.That(
                DirectorPoseMath.BoneRoleAliases["leftShoulder"], Is.EqualTo(new[] { "LeftArm", "LeftShoulder" }));
            Assert.That(
                DirectorPoseMath.BoneRoleAliases["rightKnee"], Is.EqualTo(new[] { "RightLeg", "RightLowerLeg" }));
            Assert.That(DirectorPoseMath.BoneRoleAliases["rightFoot"], Is.EqualTo(new[] { "RightFoot" }));
        }

        [Test]
        public void StaticPoseBoneRotationsMatchTheGoldenTable()
        {
            Dictionary<string, double[]> rotations =
                DirectorPoseMath.GetMixamoPoseBoneRotations(GoldenControls(), null, animated: false);
            AssertVector(rotations["body"], new[] { 0.174532925199, -0.349065850399, 0 }, "body");
            AssertVector(rotations["torso"], new[] { 0, 0, 0.261799387799 }, "torso");
            AssertVector(rotations["head"], new[] { -0.436332312999, 0, 0 }, "head");
            // 70° neutral stance + 40° spread; pitch clamps -130° to -120°.
            AssertVector(
                rotations["leftShoulder"], new[] { 1.919862177194, 0.174532925199, -2.094395102393 }, "leftShoulder");
            AssertVector(rotations["rightShoulder"], new[] { 0.785398163397, 0, -0.785398163397 }, "rightShoulder");
            // Elbow bend clamps 160° to 150°.
            AssertVector(rotations["leftElbow"], new[] { 0, 0, 2.617993877991 }, "leftElbow");
            AssertVector(rotations["rightElbow"], new[] { 0, 0, -0.523598775598 }, "rightElbow");
            AssertVector(rotations["leftHand"], new[] { 0, 0, 0.261799387799 }, "leftHand");
            AssertVector(rotations["rightHand"], new[] { 0.0, 0, 0 }, "rightHand");
            AssertVector(rotations["leftHip"], new[] { -0.523598775598, 0, -0.209439510239 }, "leftHip");
            AssertVector(rotations["rightHip"], new[] { 0, -0.314159265359, 0 }, "rightHip");
            AssertVector(rotations["leftKnee"], new[] { -1.047197551197, 0, 0 }, "leftKnee");
            AssertVector(rotations["rightKnee"], new[] { -0.785398163397, 0, 0 }, "rightKnee");
            AssertVector(rotations["leftFoot"], new[] { -0.349065850399, 0, 0 }, "leftFoot");
            AssertVector(rotations["rightFoot"], new[] { 0, 0, 0.174532925199 }, "rightFoot");
        }

        [Test]
        public void AnimatedPoseSkipsTheNeutralShoulderStance()
        {
            Dictionary<string, double[]> rotations =
                DirectorPoseMath.GetMixamoPoseBoneRotations(GoldenControls(), null, animated: true);
            AssertVector(
                rotations["leftShoulder"], new[] { 0.698131700798, 0.174532925199, -2.094395102393 }, "leftShoulder");
            AssertVector(
                rotations["rightShoulder"], new[] { -0.436332312999, 0, -0.785398163397 }, "rightShoulder");
        }

        [Test]
        public void ChildBodyScaleTightensTheClampEnvelope()
        {
            Dictionary<string, double[]> rotations =
                DirectorPoseMath.GetMixamoPoseBoneRotations(GoldenControls(), "child", animated: false);
            // Shoulder pitch clamps to ±96° and elbow bend to 120° at 72/90 scale.
            AssertVector(
                rotations["leftShoulder"], new[] { 1.919862177194, 0.174532925199, -1.675516081915 }, "leftShoulder");
            AssertVector(rotations["leftElbow"], new[] { 0, 0, 2.094395102393 }, "leftElbow");
        }

        [Test]
        public void GltfLocalQuaternionConversionMatchesTheGoldenTable()
        {
            double[] offset = DirectorSpace.QuaternionFromEulerXyz(
                1.919862177194, 0.174532925199, -2.094395102393);
            AssertVector(
                offset,
                new[] { 0.36472443581, 0.731702214251, -0.459144648138, 0.347525751089 },
                "offset gltf");
            AssertVector(
                DirectorPoseMath.GltfLocalQuaternionToUnity(offset[0], offset[1], offset[2], offset[3]),
                new[] { 0.36472443581, -0.731702214251, 0.459144648138, 0.347525751089 },
                "offset unity");

            double[] rest = DirectorSpace.QuaternionFromEulerXyz(0.35, -0.2, 1.1);
            AssertVector(
                rest,
                new[] { 0.096305260291, -0.174359963413, 0.497314190361, 0.844394751324 },
                "rest gltf");
            double[] composed = DirectorPoseMath.MultiplyQuaternions(rest, offset);
            AssertVector(
                composed,
                new[] { 0.057610506979, 0.782851614351, -0.080809731971, 0.614242758697 },
                "composed gltf");

            // The conjugation is multiplicative: converting the composed
            // rotation equals composing the converted factors.
            double[] composedFromFactors = DirectorPoseMath.MultiplyQuaternions(
                DirectorPoseMath.GltfLocalQuaternionToUnity(rest[0], rest[1], rest[2], rest[3]),
                DirectorPoseMath.GltfLocalQuaternionToUnity(offset[0], offset[1], offset[2], offset[3]));
            AssertVector(
                composedFromFactors,
                DirectorPoseMath.GltfLocalQuaternionToUnity(composed[0], composed[1], composed[2], composed[3]),
                "multiplicativity");
        }

        [Test]
        public void KeyframedPoseValueEvaluationMatchesTheGoldenTable()
        {
            var evaluator = new DirectorAnimationEvaluator(JObject.Parse(@"{
                ""version"": 1,
                ""enabled"": true,
                ""keyframes"": [
                    { ""frame"": 0, ""interpolation"": ""smooth"",
                      ""poseValues"": { ""leftShoulder.spread"": 40, ""head.yaw"": -10 } },
                    { ""frame"": 24, ""interpolation"": ""linear"",
                      ""poseValues"": { ""leftShoulder.spread"": -20, ""leftElbow.bend"": 90 } },
                    { ""frame"": 48, ""interpolation"": ""step"",
                      ""poseValues"": { ""leftShoulder.spread"": 10 } }
                ]
            }"));
            var baseControls = new Dictionary<string, double> { ["head.yaw"] = 20, ["torso.pitch"] = 5 };

            // frame, leftShoulder.spread — head.yaw pins to -10 (single key)
            // and leftElbow.bend to 90 (value of its first key) at every
            // frame, while the untouched torso.pitch base control merges
            // through unchanged. Mirrored in
            // directorDccUnityConnectorGolden.test.ts.
            double[][] golden =
            {
                new[] { 0.0, 40 },
                new[] { 6.0, 30.625 },
                new[] { 12.0, 10 },
                new[] { 24.0, -20 },
                new[] { 36.0, -5 },
                new[] { 48.0, 10 },
                new[] { 60.0, 10 },
            };
            Assert.That(evaluator.HasPoseChannels, Is.True);
            foreach (double[] row in golden)
            {
                Dictionary<string, double> pose = evaluator.EvaluatePoseValues(row[0], baseControls);
                Assert.That(pose["leftShoulder.spread"], Is.EqualTo(row[1]).Within(Tolerance), $"frame {row[0]}");
                Assert.That(pose["head.yaw"], Is.EqualTo(-10).Within(Tolerance), $"frame {row[0]} head.yaw");
                Assert.That(pose["leftElbow.bend"], Is.EqualTo(90).Within(Tolerance), $"frame {row[0]} elbow");
                Assert.That(pose["torso.pitch"], Is.EqualTo(5).Within(Tolerance), $"frame {row[0]} torso");
            }
        }
    }
}
