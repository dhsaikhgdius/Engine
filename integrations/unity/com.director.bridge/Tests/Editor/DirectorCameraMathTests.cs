using NUnit.Framework;

namespace Director.Bridge.Editor.Tests
{
    /// <summary>
    /// Golden tests for the camera math port. The look-quaternion golden
    /// values were produced by directorCameraLookQuaternion
    /// (packages/dcc-interchange/src/cameraOrientation.ts) and are asserted
    /// against the same table in
    /// packages/dcc-protocol/tests/directorDccUnityConnectorGolden.test.ts.
    /// </summary>
    public class DirectorCameraMathTests
    {
        private const double Tolerance = 1e-9;

        [Test]
        public void SensorGatesMatchTheDirectorCatalog()
        {
            AssertGate("super16", 12.52, 7.41);
            AssertGate("super35", 24.89, 18.66);
            AssertGate("fullFrame", 36.0, 24.0);
            AssertGate("imax65", 52.63, 23.01);
            // Unknown formats fall back to the full-frame gate.
            AssertGate("unknown-format", 36.0, 24.0);
        }

        private static void AssertGate(string format, double width, double height)
        {
            DirectorCameraMath.SensorGate gate = DirectorCameraMath.SensorGateForFormat(format);
            Assert.That(gate.Width, Is.EqualTo(width).Within(Tolerance));
            Assert.That(gate.Height, Is.EqualTo(height).Within(Tolerance));
        }

        [Test]
        public void UsedSensorHeightCropsAndNeverExpands()
        {
            // 16:9 on full frame: 36 / (16/9) = 20.25 < 24, so the gate crops.
            Assert.That(
                DirectorCameraMath.UsedSensorHeight("16:9", "fullFrame"), Is.EqualTo(20.25).Within(Tolerance));
            // Portrait keeps the full gate height.
            Assert.That(
                DirectorCameraMath.UsedSensorHeight("9:16", "fullFrame"), Is.EqualTo(24.0).Within(Tolerance));
        }

        [Test]
        public void VerticalFovMatchesTheDirectorFormula()
        {
            // atan(20.25 / (2 * 35)) * 2 in degrees; same formula as
            // getVerticalFovFromFocalLength in cameraGeometry.ts.
            double fov = DirectorCameraMath.VerticalFovFromFocalLength(35, "16:9", "fullFrame");
            Assert.That(fov, Is.EqualTo(32.268802171116).Within(1e-9));
        }

        [Test]
        public void LookQuaternionMatchesTheGoldenTable()
        {
            AssertQuaternion(
                DirectorCameraMath.LookQuaternion(
                    new double[] { 2, 1.5, 3 }, new double[] { -1, 0.5, -2 }, new double[3]),
                -0.081743364218, 0.265971605706, 0.022641601129, 0.960241888933);

            // Straight down flips world up to +Z.
            AssertQuaternion(
                DirectorCameraMath.LookQuaternion(
                    new double[] { 0, 5, 0 }, new double[] { 0, 0, 0 }, new double[3]),
                0, 0.707106781187, 0.707106781187, 0);

            // Coincident position and target falls back to the Euler rotation.
            AssertQuaternion(
                DirectorCameraMath.LookQuaternion(
                    new double[] { 1, 2, 3 }, new double[] { 1, 2, 3 }, new[] { 0.3, -0.7, 1.2 }),
                -0.075581533421, -0.359091362801, 0.482161948317, 0.795525411638);
        }

        private static void AssertQuaternion(double[] actual, double x, double y, double z, double w)
        {
            Assert.That(actual[0], Is.EqualTo(x).Within(Tolerance));
            Assert.That(actual[1], Is.EqualTo(y).Within(Tolerance));
            Assert.That(actual[2], Is.EqualTo(z).Within(Tolerance));
            Assert.That(actual[3], Is.EqualTo(w).Within(Tolerance));
        }
    }
}
