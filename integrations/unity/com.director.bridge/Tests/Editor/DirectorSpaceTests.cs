using NUnit.Framework;
using UnityEngine;

namespace Director.Bridge.Editor.Tests
{
    /// <summary>
    /// Golden tests for the Director-to-Unity basis change. The same golden
    /// values are asserted in TypeScript by
    /// packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts, so
    /// the C# and TS halves of the conversion cannot drift apart silently.
    /// </summary>
    public class DirectorSpaceTests
    {
        private const double Tolerance = 1e-9;

        [Test]
        public void PointConversionMatchesTheDocumentedLinearMap()
        {
            Vector3 unity = DirectorSpace.DirectorPointToUnity(1, 2, 3);
            Assert.That(unity.x, Is.EqualTo(1f));
            Assert.That(unity.y, Is.EqualTo(2f));
            Assert.That(unity.z, Is.EqualTo(-3f));

            double[] director = DirectorSpace.UnityPointToDirector(new Vector3(-4.25f, 1.5f, 9.75f));
            Assert.That(director[0], Is.EqualTo(-4.25).Within(1e-6));
            Assert.That(director[1], Is.EqualTo(1.5).Within(1e-6));
            Assert.That(director[2], Is.EqualTo(-9.75).Within(1e-6));
        }

        [Test]
        public void QuaternionConversionRoundTrips()
        {
            double[] director = DirectorSpace.QuaternionFromEulerXyz(0.3, -1.1, 2.4);
            Quaternion unity = DirectorSpace.DirectorQuaternionToUnity(
                director[0], director[1], director[2], director[3]);
            double[] roundTripped = DirectorSpace.UnityQuaternionToDirector(unity);
            double dot = 0;
            for (int index = 0; index < 4; index += 1)
            {
                dot += director[index] * roundTripped[index];
            }
            Assert.That(System.Math.Abs(dot), Is.EqualTo(1.0).Within(1e-6));
        }

        [Test]
        public void CameraForwardRayLandsOnUnityPlusZ()
        {
            // A Director camera yawed 90° left looks along Director -X;
            // the converted Unity camera must look along Unity -X too
            // (the linear map keeps X and Y, so only Z flips).
            double[] yawLeft = DirectorSpace.QuaternionFromEulerXyz(0, System.Math.PI / 2.0, 0);
            Quaternion unity = DirectorSpace.DirectorQuaternionToUnity(yawLeft[0], yawLeft[1], yawLeft[2], yawLeft[3]);
            Vector3 unityForward = unity * Vector3.forward;
            Assert.That(unityForward.x, Is.EqualTo(-1f).Within(1e-5f));
            Assert.That(unityForward.y, Is.EqualTo(0f).Within(1e-5f));
            Assert.That(unityForward.z, Is.EqualTo(0f).Within(1e-5f));

            // Identity rotation: Director forward -Z maps onto Unity forward +Z.
            Quaternion identity = DirectorSpace.DirectorQuaternionToUnity(0, 0, 0, 1);
            Vector3 identityForward = identity * Vector3.forward;
            Assert.That(identityForward.z, Is.EqualTo(1f).Within(1e-5f));
        }

        [Test]
        public void NegativeScaleKeepsTheMirroredDeterminant()
        {
            Vector3 unityScale = DirectorSpace.DirectorScaleToUnity(-1, 1, 2);
            Assert.That(unityScale.x * unityScale.y * unityScale.z, Is.LessThan(0f));
            double[] director = DirectorSpace.UnityScaleToDirector(unityScale);
            Assert.That(director[0] * director[1] * director[2], Is.LessThan(0.0));
            Assert.That(director[0], Is.EqualTo(-1.0).Within(1e-6));
        }

        [Test]
        public void BindMatrixConversionMatchesTheGoldenConjugation()
        {
            // Golden table shared with the TS test: element (row, column) is
            // negated exactly when one of row/column is the Z axis.
            double[] source =
            {
                1, 2, 3, 4,
                5, 6, 7, 8,
                9, 10, 11, 12,
                13, 14, 15, 16,
            };
            double[] expected =
            {
                1, 2, -3, 4,
                5, 6, -7, 8,
                -9, -10, 11, -12,
                13, 14, -15, 16,
            };
            double[] converted = DirectorSpace.DirectorMatrixToUnity(source);
            for (int index = 0; index < 16; index += 1)
            {
                Assert.That(converted[index], Is.EqualTo(expected[index]).Within(Tolerance), $"element {index}");
            }

            double[] involution = DirectorSpace.UnityMatrixToDirector(converted);
            for (int index = 0; index < 16; index += 1)
            {
                Assert.That(involution[index], Is.EqualTo(source[index]).Within(Tolerance), $"element {index}");
            }
        }

        [Test]
        public void BindMatrixTranslationAgreesWithPointConversion()
        {
            double[] translation =
            {
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                1, 2, 3, 1,
            };
            double[] converted = DirectorSpace.DirectorMatrixToUnity(translation);
            Vector3 point = DirectorSpace.DirectorPointToUnity(1, 2, 3);
            Assert.That(converted[12], Is.EqualTo(point.x).Within(Tolerance));
            Assert.That(converted[13], Is.EqualTo(point.y).Within(Tolerance));
            Assert.That(converted[14], Is.EqualTo(point.z).Within(Tolerance));
        }

        [Test]
        public void ComposeWorldTransformAppliesUniformSceneScale()
        {
            DirectorSpace.ComposeWorldTransform(
                new double[] { 10, 0, 0 },
                new double[] { 0, 0, 0 },
                2.0,
                new double[] { 1, 1, 1 },
                new double[] { 0, 0, 0, 1 },
                new double[] { 1, 1, 1 },
                out double[] location, out double[] quaternion, out double[] scale);
            Assert.That(location[0], Is.EqualTo(12.0).Within(Tolerance));
            Assert.That(location[1], Is.EqualTo(2.0).Within(Tolerance));
            Assert.That(location[2], Is.EqualTo(2.0).Within(Tolerance));
            Assert.That(quaternion[3], Is.EqualTo(1.0).Within(Tolerance));
            Assert.That(scale[0], Is.EqualTo(2.0).Within(Tolerance));
        }
    }
}
