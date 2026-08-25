using System;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Camera orientation and physical-gate math in Director canonical space.
    ///
    /// <see cref="LookQuaternion"/> is a direct port of
    /// packages/dcc-interchange/src/cameraOrientation.ts
    /// (directorCameraLookQuaternion): Director cameras aim at their target
    /// point; glTF/USD exporters and every engine connector must derive the
    /// same rotation so a shot framed in Director frames identically in the
    /// host. All math stays in doubles in Director space; the caller converts
    /// the result to Unity space through <see cref="DirectorSpace"/>.
    /// </summary>
    public static class DirectorCameraMath
    {
        /// <summary>One physical capture gate (millimetres), ported from cameraGeometry.ts.</summary>
        public readonly struct SensorGate
        {
            public SensorGate(double width, double height)
            {
                Width = width;
                Height = height;
            }

            public double Width { get; }
            public double Height { get; }
        }

        /// <summary>
        /// Physical capture gates in millimetres, matching
        /// DIRECTOR_CAMERA_SENSOR_FORMATS in cameraGeometry.ts.
        /// </summary>
        public static SensorGate SensorGateForFormat(string sensorFormat)
        {
            switch (sensorFormat)
            {
                case "super16":
                    return new SensorGate(12.52, 7.41);
                case "super35":
                    return new SensorGate(24.89, 18.66);
                case "imax65":
                    return new SensorGate(52.63, 23.01);
                case "fullFrame":
                default:
                    return new SensorGate(36.0, 24.0);
            }
        }

        /// <summary>Numeric aspect value for a Director aspect-ratio id (16:9 default).</summary>
        public static double AspectValue(string aspectRatio)
        {
            switch (aspectRatio)
            {
                case "9:16":
                    return 9.0 / 16.0;
                case "1:1":
                    return 1.0;
                case "4:3":
                    return 4.0 / 3.0;
                case "1.85:1":
                    return 1.85;
                case "2.39:1":
                    return 2.39;
                case "16:9":
                default:
                    return 16.0 / 9.0;
            }
        }

        /// <summary>
        /// Used sensor height in millimetres after fitting the requested output
        /// aspect inside the physical gate. Ported from
        /// getDirectorCameraUsedSensorHeight: this is a crop, never an
        /// expansion — wide outputs crop the gate top and bottom.
        /// </summary>
        public static double UsedSensorHeight(string aspectRatio, string sensorFormat)
        {
            SensorGate gate = SensorGateForFormat(sensorFormat);
            return Math.Min(gate.Height, gate.Width / AspectValue(aspectRatio));
        }

        /// <summary>
        /// Vertical field of view in degrees from a physical focal length and
        /// crop gate, ported from getVerticalFovFromFocalLength (focal length
        /// clamps to the 12–200mm range the Director UI allows).
        /// </summary>
        public static double VerticalFovFromFocalLength(double focalLengthMm, string aspectRatio, string sensorFormat)
        {
            double focal = Math.Min(200.0, Math.Max(12.0, focalLengthMm));
            double sensorHeight = UsedSensorHeight(aspectRatio, sensorFormat);
            return Math.Atan(sensorHeight / (2.0 * focal)) * 2.0 * 180.0 / Math.PI;
        }

        /// <summary>
        /// Look-at quaternion (x, y, z, w) in Director canonical space for a
        /// camera at <paramref name="position"/> aiming at <paramref name="target"/>,
        /// looking down local -Z with local +Y up. Falls back to the camera's
        /// authored Euler rotation when position and target coincide.
        /// </summary>
        public static double[] LookQuaternion(double[] position, double[] target, double[] fallbackEulerXyz)
        {
            double[] forward =
            {
                target[0] - position[0],
                target[1] - position[1],
                target[2] - position[2],
            };
            double forwardLengthSq =
                forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2];
            if (forwardLengthSq <= double.Epsilon)
            {
                return DirectorSpace.QuaternionFromEulerXyz(
                    fallbackEulerXyz[0], fallbackEulerXyz[1], fallbackEulerXyz[2]);
            }

            double forwardLength = Math.Sqrt(forwardLengthSq);
            double[] forwardUnit = { forward[0] / forwardLength, forward[1] / forwardLength, forward[2] / forwardLength };
            // World up flips to +Z when the camera looks almost straight up/down,
            // matching cameraOrientation.ts.
            double[] up = Math.Abs(forwardUnit[1]) > 0.999 ? new double[] { 0, 0, 1 } : new double[] { 0, 1, 0 };

            // three.js Matrix4.lookAt: z looks from target back to the eye.
            double[] zAxis = Normalize(new[] { -forwardUnit[0], -forwardUnit[1], -forwardUnit[2] });
            double[] xAxis = Cross(up, zAxis);
            double xLengthSq = xAxis[0] * xAxis[0] + xAxis[1] * xAxis[1] + xAxis[2] * xAxis[2];
            if (xLengthSq < 1e-12)
            {
                // Guarded degenerate case (up parallel to z): nudge the same
                // axis three.js Matrix4.lookAt does. Unreachable with the
                // up-flip guard above, kept for exact parity.
                if (Math.Abs(up[2]) == 1.0)
                {
                    zAxis[0] += 0.0001;
                }
                else
                {
                    zAxis[2] += 0.0001;
                }
                zAxis = Normalize(zAxis);
                xAxis = Cross(up, zAxis);
            }
            xAxis = Normalize(xAxis);
            double[] yAxis = Cross(zAxis, xAxis);
            return QuaternionFromBasis(xAxis, yAxis, zAxis);
        }

        private static double[] Normalize(double[] vector)
        {
            double length = Math.Sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
            if (length == 0.0)
            {
                return new double[] { 0, 0, 1 };
            }
            return new[] { vector[0] / length, vector[1] / length, vector[2] / length };
        }

        private static double[] Cross(double[] a, double[] b)
        {
            return new[]
            {
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            };
        }

        /// <summary>
        /// Quaternion from a right-handed orthonormal basis (columns x, y, z),
        /// following three.js Quaternion.setFromRotationMatrix.
        /// </summary>
        private static double[] QuaternionFromBasis(double[] x, double[] y, double[] z)
        {
            double m00 = x[0], m01 = y[0], m02 = z[0];
            double m10 = x[1], m11 = y[1], m12 = z[1];
            double m20 = x[2], m21 = y[2], m22 = z[2];
            double trace = m00 + m11 + m22;
            double qx, qy, qz, qw;
            if (trace > 0)
            {
                double s = 0.5 / Math.Sqrt(trace + 1.0);
                qw = 0.25 / s;
                qx = (m21 - m12) * s;
                qy = (m02 - m20) * s;
                qz = (m10 - m01) * s;
            }
            else if (m00 > m11 && m00 > m22)
            {
                double s = 2.0 * Math.Sqrt(1.0 + m00 - m11 - m22);
                qw = (m21 - m12) / s;
                qx = 0.25 * s;
                qy = (m01 + m10) / s;
                qz = (m02 + m20) / s;
            }
            else if (m11 > m22)
            {
                double s = 2.0 * Math.Sqrt(1.0 + m11 - m00 - m22);
                qw = (m02 - m20) / s;
                qx = (m01 + m10) / s;
                qy = 0.25 * s;
                qz = (m12 + m21) / s;
            }
            else
            {
                double s = 2.0 * Math.Sqrt(1.0 + m22 - m00 - m11);
                qw = (m10 - m01) / s;
                qx = (m02 + m20) / s;
                qy = (m12 + m21) / s;
                qz = 0.25 * s;
            }
            double length = Math.Sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            return new[] { qx / length, qy / length, qz / length, qw / length };
        }
    }
}
