using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Director.Bridge.Editor.Tests
{
    /// <summary>
    /// Golden tests for the animation evaluator port. Every golden value in
    /// this file was produced by the TypeScript reference implementation
    /// (animationEasing.ts, directorAnimation.ts, trajectoryMath.ts) and the
    /// same table is asserted in
    /// packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts.
    /// </summary>
    public class DirectorAnimationEvaluatorTests
    {
        private const double Tolerance = 1e-9;

        [Test]
        public void TimingCurvesMatchTheGoldenTable()
        {
            // progress, easeIn, easeOut, easeInOut, overshoot(0.3,-2,0.7,3)
            double[][] golden =
            {
                new[] { 0.1, 0.017026610766, 0.16057221801, 0.019722447264, -0.419775878343 },
                new[] { 0.25, 0.093464650994, 0.378138130826, 0.129161900569, -0.388025640598 },
                new[] { 0.5, 0.315356812506, 0.684643187494, 0.5, 0.5 },
                new[] { 0.75, 0.621861869174, 0.906535349006, 0.870838099431, 1.388025640598 },
                new[] { 0.9, 0.83942778199, 0.982973389234, 0.980277552736, 1.419775878343 },
            };
            foreach (double[] row in golden)
            {
                double progress = row[0];
                Assert.That(
                    DirectorAnimationEvaluator.EvaluateTimingCurve(progress, 0.42, 0, 1, 1),
                    Is.EqualTo(row[1]).Within(Tolerance), $"easeIn {progress}");
                Assert.That(
                    DirectorAnimationEvaluator.EvaluateTimingCurve(progress, 0, 0, 0.58, 1),
                    Is.EqualTo(row[2]).Within(Tolerance), $"easeOut {progress}");
                Assert.That(
                    DirectorAnimationEvaluator.EvaluateTimingCurve(progress, 0.42, 0, 0.58, 1),
                    Is.EqualTo(row[3]).Within(Tolerance), $"easeInOut {progress}");
                Assert.That(
                    DirectorAnimationEvaluator.EvaluateTimingCurve(progress, 0.3, -2, 0.7, 3),
                    Is.EqualTo(row[4]).Within(Tolerance), $"overshoot {progress}");
            }
        }

        [Test]
        public void InterpolationWeightsMatchDirectorSemantics()
        {
            Assert.That(DirectorAnimationEvaluator.InterpolationWeight("step", 0.75, null), Is.EqualTo(0.0));
            Assert.That(DirectorAnimationEvaluator.InterpolationWeight("linear", 0.75, null), Is.EqualTo(0.75));
            // Hermite smooth step: 0.25² * (3 - 0.5) = 0.15625.
            Assert.That(
                DirectorAnimationEvaluator.InterpolationWeight("smooth", 0.25, null),
                Is.EqualTo(0.15625).Within(Tolerance));
        }

        private static JObject KeyframeAnimation()
        {
            return JObject.Parse(@"{
                ""version"": 1,
                ""enabled"": true,
                ""keyframes"": [
                    { ""frame"": 0, ""interpolation"": ""smooth"",
                      ""transform"": { ""position"": [0,0,0], ""rotation"": [0,0,0], ""scale"": [1,1,1] } },
                    { ""frame"": 24, ""interpolation"": ""linear"",
                      ""transform"": { ""position"": [4,2,-6], ""rotation"": [0,1.5707963267948966,0], ""scale"": [2,2,2] } },
                    { ""frame"": 48, ""interpolation"": ""step"",
                      ""transform"": { ""position"": [8,0,0], ""rotation"": [0,3.141592653589793,0], ""scale"": [1,1,1] } }
                ]
            }");
        }

        [Test]
        public void KeyframeTransformsMatchTheGoldenTable()
        {
            var evaluator = new DirectorAnimationEvaluator(KeyframeAnimation());
            double[] basePosition = { 9, 9, 9 };
            double[] baseRotation = { 0, 0, 0 };
            double[] baseScale = { 1, 1, 1 };

            // frame, px, py, pz, ry, s (uniform)
            double[][] golden =
            {
                new[] { 0.0, 0, 0, 0, 0, 1 },
                new[] { 6.0, 0.625, 0.3125, -0.9375, 0.245436926062, 1.15625 },
                new[] { 12.0, 2, 1, -3, 0.785398163397, 1.5 },
                new[] { 30.0, 5, 1.5, -4.5, 1.963495408494, 1.75 },
                new[] { 47.0, 7.833333333333, 0.083333333333, -0.25, 3.07614280664, 1.041666666667 },
                new[] { 48.0, 8, 0, 0, 3.14159265359, 1 },
                new[] { 60.0, 8, 0, 0, 3.14159265359, 1 },
            };
            foreach (double[] row in golden)
            {
                evaluator.EvaluateTransform(
                    row[0], basePosition, baseRotation, baseScale,
                    out double[] position, out double[] rotation, out double[] scale);
                Assert.That(position[0], Is.EqualTo(row[1]).Within(1e-9), $"frame {row[0]} px");
                Assert.That(position[1], Is.EqualTo(row[2]).Within(1e-9), $"frame {row[0]} py");
                Assert.That(position[2], Is.EqualTo(row[3]).Within(1e-9), $"frame {row[0]} pz");
                Assert.That(rotation[1], Is.EqualTo(row[4]).Within(1e-9), $"frame {row[0]} ry");
                Assert.That(scale[0], Is.EqualTo(row[5]).Within(1e-9), $"frame {row[0]} s");
            }
        }

        [Test]
        public void CircleTrajectoryMatchesTheGoldenTable()
        {
            var evaluator = new DirectorAnimationEvaluator(JObject.Parse(@"{
                ""version"": 1,
                ""enabled"": true,
                ""preset"": ""circle"",
                ""orientToPath"": true,
                ""circle"": { ""center"": [1, 0.5, -1], ""radius"": 2, ""startAngle"": 0, ""clockwise"": false },
                ""keyframes"": [
                    { ""frame"": 0, ""interpolation"": ""linear"",
                      ""transform"": { ""position"": [3,0.5,-1], ""rotation"": [0,0,0], ""scale"": [1,1,1] } },
                    { ""frame"": 40, ""interpolation"": ""linear"",
                      ""transform"": { ""position"": [3,0.5,-1], ""rotation"": [0,0,0], ""scale"": [1,1,1] } }
                ]
            }"));
            double[] zero = { 0, 0, 0 };
            double[] one = { 1, 1, 1 };

            double[][] golden =
            {
                new[] { 0.0, 3, 0.5, -1, 0 },
                new[] { 10.0, 1, 0.5, 1, -1.570796326795 },
                new[] { 25.0, -0.414213562373, 0.5, -2.414213562373, 2.356194490192 },
                new[] { 40.0, 3, 0.5, -1, 0 },
            };
            foreach (double[] row in golden)
            {
                evaluator.EvaluateTransform(row[0], zero, zero, one, out double[] position, out double[] rotation, out _);
                Assert.That(position[0], Is.EqualTo(row[1]).Within(1e-9), $"frame {row[0]} px");
                Assert.That(position[1], Is.EqualTo(row[2]).Within(1e-9), $"frame {row[0]} py");
                Assert.That(position[2], Is.EqualTo(row[3]).Within(1e-9), $"frame {row[0]} pz");
                Assert.That(rotation[1], Is.EqualTo(row[4]).Within(1e-9), $"frame {row[0]} ry");
            }
        }

        [Test]
        public void BezierTrajectoryWithSpeedMatchesTheGoldenTable()
        {
            var evaluator = new DirectorAnimationEvaluator(JObject.Parse(@"{
                ""version"": 1,
                ""enabled"": true,
                ""preset"": ""custom"",
                ""orientToPath"": true,
                ""speed"": 2,
                ""keyframes"": [
                    { ""frame"": 0, ""interpolation"": ""smooth"",
                      ""transform"": { ""position"": [0,0,0], ""rotation"": [0,0,0], ""scale"": [1,1,1] },
                      ""curve"": { ""out"": [1,0,2] } },
                    { ""frame"": 60, ""interpolation"": ""smooth"",
                      ""transform"": { ""position"": [6,0,-3], ""rotation"": [0,0,0], ""scale"": [1,1,1] },
                      ""curve"": { ""in"": [-2,0,-1] } }
                ]
            }"));
            double[] zero = { 0, 0, 0 };
            double[] one = { 1, 1, 1 };

            double[][] golden =
            {
                new[] { 0.0, 0, 0, 0, 0.463647609001 },
                new[] { 10.0, 1.128791342783, 0, 0.203779911599, 2.12656907991 },
                new[] { 20.0, 4.295076969974, 0, -2.627648224356, 2.181403073254 },
                new[] { 30.0, 6, 0, -3, 0 },
            };
            foreach (double[] row in golden)
            {
                evaluator.EvaluateTransform(row[0], zero, zero, one, out double[] position, out double[] rotation, out _);
                Assert.That(position[0], Is.EqualTo(row[1]).Within(1e-9), $"frame {row[0]} px");
                Assert.That(position[1], Is.EqualTo(row[2]).Within(1e-9), $"frame {row[0]} py");
                Assert.That(position[2], Is.EqualTo(row[3]).Within(1e-9), $"frame {row[0]} pz");
                Assert.That(rotation[1], Is.EqualTo(row[4]).Within(1e-9), $"frame {row[0]} ry");
            }
        }

        [Test]
        public void CameraChannelsPoseChannelsAndUnsupportedChannelsAreReported()
        {
            var evaluator = new DirectorAnimationEvaluator(JObject.Parse(@"{
                ""version"": 1,
                ""enabled"": true,
                ""keyframes"": [
                    { ""frame"": 0, ""fov"": 40, ""lookTarget"": [0,1,0], ""lookTargetObjectId"": ""hero"",
                      ""poseValues"": { ""leftShoulder.spread"": 40 } },
                    { ""frame"": 20, ""fov"": 60, ""lookTarget"": [2,1,0], ""lookTargetObjectId"": null,
                      ""poseValues"": { ""leftShoulder.spread"": -20 } }
                ],
                ""motionBlocks"": [
                    { ""id"": ""walk"", ""clipId"": ""mixamo:walk"", ""enabled"": true, ""loop"": ""loop"",
                      ""speed"": 1, ""weight"": 1, ""blendInS"": 0.2, ""blendOutS"": 0.2,
                      ""rootMotion"": ""in-place"", ""frameStart"": 0, ""frameEnd"": 20 }
                ]
            }"));

            Assert.That(evaluator.HasFovChannel, Is.True);
            Assert.That(evaluator.HasLookChannel, Is.True);
            Assert.That(evaluator.HasBakeableTransform, Is.False);
            Assert.That(evaluator.EvaluateFov(10), Is.EqualTo(50.0).Within(Tolerance));
            double[] lookTarget = evaluator.EvaluateLookTarget(10);
            Assert.That(lookTarget[0], Is.EqualTo(1.0).Within(Tolerance));
            Assert.That(evaluator.EvaluateWaypointTargetObjectId(10), Is.EqualTo("hero"));
            Assert.That(evaluator.EvaluateWaypointTargetObjectId(20), Is.Null);

            Assert.That(evaluator.HasPoseChannels, Is.True);
            var baseControls = new System.Collections.Generic.Dictionary<string, double>
            {
                ["torso.pitch"] = 5.0,
            };
            System.Collections.Generic.Dictionary<string, double> pose =
                evaluator.EvaluatePoseValues(10, baseControls);
            Assert.That(pose["leftShoulder.spread"], Is.EqualTo(10.0).Within(Tolerance));
            Assert.That(pose["torso.pitch"], Is.EqualTo(5.0).Within(Tolerance), "base controls merge through");

            Assert.That(evaluator.UnsupportedChannels, Does.Not.Contain("poseValues"));
            Assert.That(evaluator.UnsupportedChannels, Does.Contain("motionBlocks"));
        }

        [Test]
        public void CameraAnimationFrameAppliesPathSpeedClamped()
        {
            var evaluator = new DirectorAnimationEvaluator(KeyframeAnimation());
            Assert.That(evaluator.CameraAnimationFrame(12, "path", 2.0), Is.EqualTo(24.0).Within(Tolerance));
            Assert.That(evaluator.CameraAnimationFrame(100, "path", 2.0), Is.EqualTo(48.0).Within(Tolerance));
            Assert.That(evaluator.CameraAnimationFrame(12, "still", 2.0), Is.EqualTo(12.0).Within(Tolerance));
        }
    }
}
