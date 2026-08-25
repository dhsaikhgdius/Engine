using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Coordinate conversion between Director canonical space and Unity.
    ///
    /// Director canonical space: right-handed, Y-up, metres, camera forward -Z.
    /// Unity world space: left-handed, Y-up, metres, camera forward +Z.
    ///
    /// The Director protocol pins the basis change as the signed permutation
    /// (x, y, z) -> (x, y, -z); see
    /// packages/dcc-protocol/src/directorDccEngineSpace.ts. Conjugating a
    /// rotation by this improper permutation P (det -1) equals conjugating by
    /// the proper rotation -P, so quaternion vector parts transform as
    /// v -> -P v = (-x, -y, z) with w unchanged. Scale components stay put
    /// because the permutation is diagonal.
    /// </summary>
    public static class DirectorSpace
    {
        public static Vector3 DirectorPointToUnity(double x, double y, double z)
        {
            return new Vector3((float)x, (float)y, (float)(-z));
        }

        public static double[] UnityPointToDirector(Vector3 point)
        {
            return new double[] { point.x, point.y, -point.z };
        }

        public static Quaternion DirectorQuaternionToUnity(double x, double y, double z, double w)
        {
            var converted = new Quaternion((float)(-x), (float)(-y), (float)z, (float)w);
            converted.Normalize();
            return converted;
        }

        public static double[] UnityQuaternionToDirector(Quaternion rotation)
        {
            rotation.Normalize();
            return new double[] { -rotation.x, -rotation.y, rotation.z, rotation.w };
        }

        public static Vector3 DirectorScaleToUnity(double x, double y, double z)
        {
            return new Vector3((float)x, (float)y, (float)z);
        }

        public static double[] UnityScaleToDirector(Vector3 scale)
        {
            return new double[] { scale.x, scale.y, scale.z };
        }

        /// <summary>
        /// Composes the Director scene transform (uniform scale) with an
        /// entity's local TRS in Director space. Uniform scene scale commutes
        /// with rotation, so the decomposition is exact.
        /// </summary>
        public static void ComposeWorldTransform(
            double[] scenePosition,
            double[] sceneRotationEulerXyz,
            double sceneScale,
            double[] localPosition,
            double[] localRotationQuaternion,
            double[] localScale,
            out double[] worldLocation,
            out double[] worldRotationQuaternion,
            out double[] worldScale)
        {
            double[] sceneQuaternion = QuaternionFromEulerXyz(
                sceneRotationEulerXyz[0], sceneRotationEulerXyz[1], sceneRotationEulerXyz[2]);
            double[] scaled =
            {
                localPosition[0] * sceneScale,
                localPosition[1] * sceneScale,
                localPosition[2] * sceneScale,
            };
            double[] rotated = RotateVector(sceneQuaternion, scaled);
            worldLocation = new[]
            {
                rotated[0] + scenePosition[0],
                rotated[1] + scenePosition[1],
                rotated[2] + scenePosition[2],
            };
            worldRotationQuaternion = Normalize(Multiply(sceneQuaternion, localRotationQuaternion));
            worldScale = new[] { localScale[0] * sceneScale, localScale[1] * sceneScale, localScale[2] * sceneScale };
        }

        /// <summary>Quaternion for Director's intrinsic XYZ Euler order (three.js "XYZ").</summary>
        public static double[] QuaternionFromEulerXyz(double rx, double ry, double rz)
        {
            double c1 = System.Math.Cos(rx / 2.0), s1 = System.Math.Sin(rx / 2.0);
            double c2 = System.Math.Cos(ry / 2.0), s2 = System.Math.Sin(ry / 2.0);
            double c3 = System.Math.Cos(rz / 2.0), s3 = System.Math.Sin(rz / 2.0);
            return new[]
            {
                s1 * c2 * c3 + c1 * s2 * s3,
                c1 * s2 * c3 - s1 * c2 * s3,
                c1 * c2 * s3 + s1 * s2 * c3,
                c1 * c2 * c3 - s1 * s2 * s3,
            };
        }

        private static double[] Multiply(double[] a, double[] b)
        {
            return new[]
            {
                a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
                a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
                a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
            };
        }

        private static double[] Normalize(double[] q)
        {
            double length = System.Math.Sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (length == 0.0)
            {
                return new double[] { 0.0, 0.0, 0.0, 1.0 };
            }
            return new[] { q[0] / length, q[1] / length, q[2] / length, q[3] / length };
        }

        private static double[] RotateVector(double[] q, double[] v)
        {
            double tx = 2.0 * (q[1] * v[2] - q[2] * v[1]);
            double ty = 2.0 * (q[2] * v[0] - q[0] * v[2]);
            double tz = 2.0 * (q[0] * v[1] - q[1] * v[0]);
            return new[]
            {
                v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
                v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
                v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
            };
        }
    }
}
