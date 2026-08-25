using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Direct C# port of Director's animation evaluation for exchange-package
    /// baking, mirrored from packages/project-schema/src/animationEasing.ts,
    /// directorAnimation.ts, and trajectoryMath.ts. All values stay in
    /// Director canonical space (right-handed, Y-up, metres); the Timeline
    /// baker converts each sample to Unity space at the provider boundary.
    ///
    /// Supported channels: transform keyframes (step/linear/smooth easing plus
    /// CSS cubic-bezier timing curves), trajectory presets (speed, bezier
    /// position handles, circle geometry, orient-to-path), camera fov,
    /// camera look targets, and camera waypoint target objects. Unsupported
    /// channels (character pose values, skeletal motion blocks, procedural
    /// gait) are surfaced through <see cref="UnsupportedChannels"/> so the
    /// importer can warn-and-omit instead of silently flattening them.
    /// </summary>
    public sealed class DirectorAnimationEvaluator
    {
        private const string DefaultInterpolation = "linear";

        private struct Key<T>
        {
            public double Frame;
            public string Interpolation;
            public double[] TimingCurve; // x1, y1, x2, y2 or null
            public T Value;
        }

        private struct TransformValue
        {
            public double[] Position;
            public double[] RotationEuler;
            public double[] Scale;
            public double[] CurveIn;  // bezier handle or null
            public double[] CurveOut; // bezier handle or null
        }

        private sealed class CircleGeometry
        {
            public double[] Center;
            public double Radius;
            public double StartAngle;
            public bool Clockwise;
        }

        private readonly bool _enabled;
        private readonly string _preset;
        private readonly double? _speed;
        private readonly bool _orientToPath;
        private readonly CircleGeometry _circle;
        private readonly List<Key<TransformValue>> _transformKeys = new List<Key<TransformValue>>();
        private readonly List<Key<double>> _fovKeys = new List<Key<double>>();
        private readonly List<Key<double[]>> _lookTargetKeys = new List<Key<double[]>>();
        private readonly List<(double Frame, string TargetObjectId)> _waypointTargets =
            new List<(double, string)>();

        /// <summary>Channels present in the animation that this evaluator does not bake.</summary>
        public IReadOnlyList<string> UnsupportedChannels { get; }

        /// <summary>Lowest keyframe frame, or null when the animation has no keyframes.</summary>
        public double? FirstFrame { get; }

        /// <summary>Highest keyframe frame, or null when the animation has no keyframes.</summary>
        public double? LastFrame { get; }

        /// <summary>True when the animation is enabled and carries bakeable transform keys.</summary>
        public bool HasBakeableTransform => _enabled && _transformKeys.Count > 0;

        /// <summary>True when the animation carries camera fov keys.</summary>
        public bool HasFovChannel => _enabled && _fovKeys.Count > 0;

        /// <summary>True when the animation carries look-target keys or waypoint target objects.</summary>
        public bool HasLookChannel => _enabled && (_lookTargetKeys.Count > 0 || _waypointTargets.Count > 0);

        public DirectorAnimationEvaluator(JObject animation)
        {
            var unsupported = new List<string>();
            _enabled = animation?["enabled"] == null || (bool)animation["enabled"];
            _preset = (string)animation?["preset"];
            _speed = (double?)animation?["speed"];
            _orientToPath = animation?["orientToPath"] != null && (bool)animation["orientToPath"];
            JObject circle = (JObject)animation?["circle"];
            if (circle != null)
            {
                _circle = new CircleGeometry
                {
                    Center = Vec3(circle["center"]),
                    Radius = (double)circle["radius"],
                    StartAngle = (double)circle["startAngle"],
                    Clockwise = (bool)circle["clockwise"],
                };
            }

            double? firstFrame = null;
            double? lastFrame = null;
            foreach (JToken keyframeToken in (JArray)(animation?["keyframes"] ?? new JArray()))
            {
                var keyframe = (JObject)keyframeToken;
                double frame = (double)keyframe["frame"];
                firstFrame = firstFrame == null ? frame : Math.Min(firstFrame.Value, frame);
                lastFrame = lastFrame == null ? frame : Math.Max(lastFrame.Value, frame);
                string interpolation = (string)keyframe["interpolation"] ?? DefaultInterpolation;
                double[] timingCurve = null;
                JObject curveObject = (JObject)keyframe["timingCurve"];
                if (curveObject != null)
                {
                    timingCurve = new[]
                    {
                        (double)curveObject["x1"], (double)curveObject["y1"],
                        (double)curveObject["x2"], (double)curveObject["y2"],
                    };
                }

                JObject transform = (JObject)keyframe["transform"];
                if (transform != null)
                {
                    JObject handles = (JObject)keyframe["curve"];
                    _transformKeys.Add(new Key<TransformValue>
                    {
                        Frame = frame,
                        Interpolation = interpolation,
                        TimingCurve = timingCurve,
                        Value = new TransformValue
                        {
                            Position = Vec3(transform["position"]),
                            RotationEuler = Vec3(transform["rotation"]),
                            Scale = Vec3(transform["scale"]),
                            CurveIn = handles?["in"] == null ? null : Vec3(handles["in"]),
                            CurveOut = handles?["out"] == null ? null : Vec3(handles["out"]),
                        },
                    });
                }
                if (keyframe["fov"] != null)
                {
                    _fovKeys.Add(new Key<double>
                    {
                        Frame = frame,
                        Interpolation = interpolation,
                        TimingCurve = timingCurve,
                        Value = (double)keyframe["fov"],
                    });
                }
                if (keyframe["lookTarget"] != null)
                {
                    _lookTargetKeys.Add(new Key<double[]>
                    {
                        Frame = frame,
                        Interpolation = interpolation,
                        TimingCurve = timingCurve,
                        Value = Vec3(keyframe["lookTarget"]),
                    });
                }
                if (keyframe["lookTargetObjectId"] != null)
                {
                    _waypointTargets.Add((frame, (string)keyframe["lookTargetObjectId"]));
                }
                if (keyframe["poseValues"] is JObject poseValues && poseValues.Count > 0 &&
                    !unsupported.Contains("poseValues"))
                {
                    unsupported.Add("poseValues");
                }
            }
            FirstFrame = firstFrame;
            LastFrame = lastFrame;

            if (animation?["motionBlocks"] is JArray motionBlocks && motionBlocks.Count > 0)
            {
                unsupported.Add("motionBlocks");
            }
            string motion = (string)animation?["motion"];
            if (motion != null && motion != "none")
            {
                unsupported.Add("motion");
            }
            UnsupportedChannels = unsupported;

            _transformKeys.Sort((left, right) => left.Frame.CompareTo(right.Frame));
            _fovKeys.Sort((left, right) => left.Frame.CompareTo(right.Frame));
            _lookTargetKeys.Sort((left, right) => left.Frame.CompareTo(right.Frame));
            _waypointTargets.Sort((left, right) => left.Frame.CompareTo(right.Frame));
        }

        /// <summary>
        /// CSS cubic-bezier easing, ported verbatim from animationEasing.ts
        /// (Newton refinement, then bisection, both with 1e-6 tolerance).
        /// </summary>
        public static double EvaluateTimingCurve(double progress, double x1, double y1, double x2, double y2)
        {
            double requestedX = Clamp(progress, 0, 1);
            double clampedX1 = Clamp(x1, 0, 1);
            double clampedX2 = Clamp(x2, 0, 1);
            double t = requestedX;

            for (int iteration = 0; iteration < 8; iteration += 1)
            {
                double error = CubicCoordinate(t, clampedX1, clampedX2) - requestedX;
                if (Math.Abs(error) < 0.000001) break;
                double derivative = CubicDerivative(t, clampedX1, clampedX2);
                if (Math.Abs(derivative) < 0.000001) break;
                double next = t - error / derivative;
                if (next < 0 || next > 1) break;
                t = next;
            }

            double lower = 0;
            double upper = 1;
            for (int iteration = 0; iteration < 12; iteration += 1)
            {
                double resolvedX = CubicCoordinate(t, clampedX1, clampedX2);
                if (Math.Abs(resolvedX - requestedX) < 0.000001) break;
                if (resolvedX < requestedX) lower = t;
                else upper = t;
                t = (lower + upper) / 2;
            }

            return CubicCoordinate(t, y1, y2);
        }

        /// <summary>
        /// Effective 0–1 weight for one keyframe segment, ported from
        /// getDirectorInterpolationWeight: step snaps to the left key, a
        /// timing curve delegates to the bezier solver, smooth uses Hermite
        /// easing, and everything else is linear.
        /// </summary>
        public static double InterpolationWeight(string interpolation, double progress, double[] timingCurve)
        {
            if (interpolation == "step") return 0;
            double clamped = Clamp(progress, 0, 1);
            if (timingCurve != null)
            {
                return EvaluateTimingCurve(clamped, timingCurve[0], timingCurve[1], timingCurve[2], timingCurve[3]);
            }
            return interpolation == "smooth" ? clamped * clamped * (3 - 2 * clamped) : clamped;
        }

        /// <summary>
        /// Evaluates the Director-space transform at a frame: trajectory preset
        /// first, then transform keyframe channels, then the base transform —
        /// the same priority as evaluateDirectorObjectAtFrame.
        /// </summary>
        public void EvaluateTransform(
            double frame,
            double[] basePosition,
            double[] baseRotationEuler,
            double[] baseScale,
            out double[] position,
            out double[] rotationEuler,
            out double[] scale)
        {
            if (!_enabled)
            {
                position = (double[])basePosition.Clone();
                rotationEuler = (double[])baseRotationEuler.Clone();
                scale = (double[])baseScale.Clone();
                return;
            }
            if (EvaluateTrajectory(frame, out position, out rotationEuler, out scale)) return;
            if (EvaluateTransformChannel(frame, out position, out rotationEuler, out scale)) return;
            position = (double[])basePosition.Clone();
            rotationEuler = (double[])baseRotationEuler.Clone();
            scale = (double[])baseScale.Clone();
        }

        /// <summary>Camera fov (vertical degrees) at a frame, or null without fov keys.</summary>
        public double? EvaluateFov(double frame)
        {
            if (!_enabled || _fovKeys.Count == 0) return null;
            return EvaluateSortedKeys(_fovKeys, frame, (left, right, weight) => left + (right - left) * weight);
        }

        /// <summary>Interpolated look-target point at a frame, or null without look keys.</summary>
        public double[] EvaluateLookTarget(double frame)
        {
            if (!_enabled || _lookTargetKeys.Count == 0) return null;
            return EvaluateSortedKeys(_lookTargetKeys, frame, LerpVec3);
        }

        /// <summary>
        /// Waypoint look-target object id active at a frame (last waypoint at or
        /// before the frame), ported from getCameraWaypointTargetObjectId.
        /// </summary>
        public string EvaluateWaypointTargetObjectId(double frame)
        {
            if (!_enabled || _waypointTargets.Count == 0) return null;
            string active = null;
            foreach ((double keyFrame, string targetObjectId) in _waypointTargets)
            {
                if (keyFrame <= frame) active = targetObjectId;
                else break;
            }
            return active;
        }

        /// <summary>
        /// Maps a timeline frame to the authored keyframe frame for camera path
        /// actions (ported from getDirectorCameraAnimationFrame): path playback
        /// can run faster or slower than the timeline.
        /// </summary>
        public double CameraAnimationFrame(double frame, string actionMode, double? pathSpeed)
        {
            if (_transformKeys.Count == 0 && _fovKeys.Count == 0 && _lookTargetKeys.Count == 0 &&
                _waypointTargets.Count == 0)
            {
                return frame;
            }
            if (actionMode != "path") return frame;
            if (FirstFrame == null || LastFrame == null) return frame;
            double speed = pathSpeed ?? 1;
            return Math.Min(
                LastFrame.Value,
                Math.Max(FirstFrame.Value, FirstFrame.Value + (frame - FirstFrame.Value) * speed));
        }

        private bool EvaluateTransformChannel(
            double frame, out double[] position, out double[] rotationEuler, out double[] scale)
        {
            position = rotationEuler = scale = null;
            if (_transformKeys.Count == 0) return false;
            TransformValue value = EvaluateSortedKeys(
                _transformKeys,
                frame,
                (left, right, weight) => new TransformValue
                {
                    Position = LerpVec3(left.Position, right.Position, weight),
                    RotationEuler = LerpVec3(left.RotationEuler, right.RotationEuler, weight),
                    Scale = LerpVec3(left.Scale, right.Scale, weight),
                });
            position = value.Position;
            rotationEuler = value.RotationEuler;
            scale = value.Scale;
            return true;
        }

        /// <summary>Port of evaluateTrajectoryTransform (speed, bezier handles, circle, orient-to-path).</summary>
        private bool EvaluateTrajectory(
            double frame, out double[] position, out double[] rotationEuler, out double[] scale)
        {
            position = rotationEuler = scale = null;
            if (_preset == null || _transformKeys.Count == 0) return false;
            if (_transformKeys.Count == 1)
            {
                TransformValue only = _transformKeys[0].Value;
                position = (double[])only.Position.Clone();
                rotationEuler = (double[])only.RotationEuler.Clone();
                scale = (double[])only.Scale.Clone();
                return true;
            }

            double firstFrame = _transformKeys[0].Frame;
            double lastFrame = _transformKeys[_transformKeys.Count - 1].Frame;
            double spedFrame = _speed != null
                ? firstFrame + (frame - firstFrame) * Math.Max(0.1, _speed.Value)
                : frame;
            double clampedFrame = Clamp(spedFrame, firstFrame, lastFrame);

            int leftIndex = 0;
            for (int index = _transformKeys.Count - 1; index >= 0; index -= 1)
            {
                if (_transformKeys[index].Frame <= clampedFrame)
                {
                    leftIndex = index;
                    break;
                }
            }
            int rightIndex = leftIndex;
            for (int index = 0; index < _transformKeys.Count; index += 1)
            {
                if (_transformKeys[index].Frame > clampedFrame)
                {
                    rightIndex = index;
                    break;
                }
            }
            Key<TransformValue> left = _transformKeys[leftIndex];
            Key<TransformValue> right = _transformKeys[rightIndex];
            double rawProgress = rightIndex == leftIndex
                ? 0
                : (clampedFrame - left.Frame) / Math.Max(1, right.Frame - left.Frame);
            double progress = InterpolationWeight(left.Interpolation, rawProgress, left.TimingCurve);

            rotationEuler = LerpVec3(left.Value.RotationEuler, right.Value.RotationEuler, progress);
            bool hasBezierHandles = left.Value.CurveOut != null || right.Value.CurveIn != null;
            double[] startHandle = AddVec3(left.Value.Position, left.Value.CurveOut ?? new double[3]);
            double[] endHandle = AddVec3(right.Value.Position, right.Value.CurveIn ?? new double[3]);
            position = hasBezierHandles
                ? CubicBezierPoint(left.Value.Position, startHandle, endHandle, right.Value.Position, progress)
                : LerpVec3(left.Value.Position, right.Value.Position, progress);

            if (_circle != null)
            {
                double duration = Math.Max(1, lastFrame - firstFrame);
                double circleRawProgress = Clamp((clampedFrame - firstFrame) / duration, 0, 1);
                double circleProgress = InterpolationWeight(
                    _transformKeys[0].Interpolation, circleRawProgress, _transformKeys[0].TimingCurve);
                double direction = _circle.Clockwise ? -1 : 1;
                double angle = _circle.StartAngle + direction * Math.PI * 2 * circleProgress;
                position = new[]
                {
                    _circle.Center[0] + Math.Cos(angle) * _circle.Radius,
                    _circle.Center[1],
                    _circle.Center[2] + Math.Sin(angle) * _circle.Radius,
                };
                if (clampedFrame == firstFrame) position = (double[])_transformKeys[0].Value.Position.Clone();
                if (clampedFrame == lastFrame)
                {
                    position = (double[])_transformKeys[_transformKeys.Count - 1].Value.Position.Clone();
                }
                if (_orientToPath)
                {
                    rotationEuler[1] = Math.Atan2(-Math.Sin(angle) * direction, Math.Cos(angle) * direction);
                }
            }
            else if (_orientToPath && rightIndex != leftIndex)
            {
                double[] tangent = hasBezierHandles
                    ? CubicBezierTangent(left.Value.Position, startHandle, endHandle, right.Value.Position, progress)
                    : new[]
                    {
                        right.Value.Position[0] - left.Value.Position[0],
                        right.Value.Position[1] - left.Value.Position[1],
                        right.Value.Position[2] - left.Value.Position[2],
                    };
                double deltaX = tangent[0];
                double deltaZ = tangent[2];
                if (Math.Sqrt(deltaX * deltaX + deltaZ * deltaZ) > 0.0001)
                {
                    rotationEuler[1] = Math.Atan2(deltaX, deltaZ);
                }
            }

            scale = LerpVec3(left.Value.Scale, right.Value.Scale, progress);
            return true;
        }

        /// <summary>
        /// Lower-bound keyframe lookup with per-segment easing, ported from
        /// evaluateSortedKeyedValue: an exact frame resolves to its first
        /// authored key; interpolation uses the left key's easing.
        /// </summary>
        private static T EvaluateSortedKeys<T>(
            List<Key<T>> keyframes, double frame, Func<T, T, double, T> interpolate)
        {
            int low = 0;
            int high = keyframes.Count;
            while (low < high)
            {
                int middle = (low + high) >> 1;
                if (keyframes[middle].Frame < frame) low = middle + 1;
                else high = middle;
            }
            if (low < keyframes.Count && keyframes[low].Frame == frame) return keyframes[low].Value;
            if (low == 0) return keyframes[0].Value;
            if (low == keyframes.Count) return keyframes[keyframes.Count - 1].Value;

            Key<T> left = keyframes[low - 1];
            Key<T> right = keyframes[low];
            double distance = right.Frame - left.Frame;
            double progress = distance <= 0 ? 0 : (frame - left.Frame) / distance;
            double weight = InterpolationWeight(left.Interpolation, progress, left.TimingCurve);
            return interpolate(left.Value, right.Value, weight);
        }

        private static double[] CubicBezierPoint(
            double[] start, double[] startHandle, double[] endHandle, double[] end, double progress)
        {
            double t = Clamp(progress, 0, 1);
            double inverse = 1 - t;
            double startWeight = inverse * inverse * inverse;
            double startHandleWeight = 3 * inverse * inverse * t;
            double endHandleWeight = 3 * inverse * t * t;
            double endWeight = t * t * t;
            return Enumerable.Range(0, 3)
                .Select(axis =>
                    start[axis] * startWeight + startHandle[axis] * startHandleWeight +
                    endHandle[axis] * endHandleWeight + end[axis] * endWeight)
                .ToArray();
        }

        private static double[] CubicBezierTangent(
            double[] start, double[] startHandle, double[] endHandle, double[] end, double progress)
        {
            double t = Clamp(progress, 0, 1);
            double inverse = 1 - t;
            return Enumerable.Range(0, 3)
                .Select(axis =>
                    3 * inverse * inverse * (startHandle[axis] - start[axis]) +
                    6 * inverse * t * (endHandle[axis] - startHandle[axis]) +
                    3 * t * t * (end[axis] - endHandle[axis]))
                .ToArray();
        }

        private static double CubicCoordinate(double t, double first, double second)
        {
            double inverse = 1 - t;
            return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
        }

        private static double CubicDerivative(double t, double first, double second)
        {
            double inverse = 1 - t;
            return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) + 3 * t * t * (1 - second);
        }

        private static double[] LerpVec3(double[] left, double[] right, double weight)
        {
            return new[]
            {
                left[0] + (right[0] - left[0]) * weight,
                left[1] + (right[1] - left[1]) * weight,
                left[2] + (right[2] - left[2]) * weight,
            };
        }

        private static double[] AddVec3(double[] left, double[] right)
        {
            return new[] { left[0] + right[0], left[1] + right[1], left[2] + right[2] };
        }

        private static double Clamp(double value, double min, double max)
        {
            return Math.Min(max, Math.Max(min, value));
        }

        private static double[] Vec3(JToken token)
        {
            return new[] { (double)token[0], (double)token[1], (double)token[2] };
        }
    }
}
