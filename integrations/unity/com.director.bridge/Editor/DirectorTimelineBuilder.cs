using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Builds one Unity Timeline per Director exchange package:
    ///
    /// - Storyboard shots become ActivationTrack clips over their camera
    ///   GameObjects, so scrubbing the Timeline switches shot cameras at the
    ///   authored frame ranges.
    /// - Director keyframe/trajectory animation is baked per entity into
    ///   AnimationClips through <see cref="DirectorAnimationEvaluator"/> (the
    ///   C# port of Director's evaluator), sampled once per Director frame in
    ///   canonical space and converted to Unity space per sample. Cameras bake
    ///   look-at rotation, follow/path targets, and fov/focal-length channels
    ///   with the same priority as Director playback.
    ///
    /// The interchange stays GLB + manifest JSON: the Timeline and clips are
    /// generated Unity assets derived from the manifest, and `.unity` YAML is
    /// never parsed or emitted as an exchange format. Channels the connector
    /// cannot bake (character pose values, skeletal motion blocks, procedural
    /// gait) warn-and-omit through the evaluator's UnsupportedChannels.
    /// </summary>
    public static class DirectorTimelineBuilder
    {
        /// <summary>Baking stops subdividing beyond this many samples per entity.</summary>
        private const int MaxSamplesPerEntity = 24_000;

        /// <summary>The outcome of one timeline build.</summary>
        public sealed class Result
        {
            /// <summary>Project-relative path of the TimelineAsset, or null when nothing was built.</summary>
            public string TimelinePath;

            /// <summary>Number of baked AnimationClips.</summary>
            public int BakedAnimationClipCount;
        }

        private sealed class AnimatedEntity
        {
            public JObject Entity;
            public bool IsCamera;
            public DirectorAnimationEvaluator Evaluator;
            public GameObject GameObject;
        }

        /// <summary>Builds the Timeline for one imported package. Returns clip counts and the asset path.</summary>
        public static Result Build(
            JObject manifest,
            string shortId,
            Dictionary<string, GameObject> byDirectorId,
            Dictionary<string, GameObject> cameras,
            List<string> warnings)
        {
            var result = new Result { TimelinePath = null, BakedAnimationClipCount = 0 };
            JObject project = (JObject)manifest["project"];
            JObject scene = (JObject)project["scene"];
            double fps = (double?)project["scene"]?["timeline"]?["fps"] ?? 24.0;

            var animated = CollectAnimatedEntities(project, byDirectorId, warnings);
            var shots = CollectShots(project, cameras);
            if (animated.Count == 0 && shots.Count == 0)
            {
                return result;
            }

            Directory.CreateDirectory("Assets/Director/Timelines");
            string timelinePath = $"Assets/Director/Timelines/Director_{shortId}.playable";
            var timeline = ScriptableObject.CreateInstance<TimelineAsset>();
            timeline.editorSettings.frameRate = fps;
            AssetDatabase.CreateAsset(timeline, timelinePath);

            var timelineHost = new GameObject("Director Timeline");
            var playableDirector = timelineHost.AddComponent<PlayableDirector>();
            playableDirector.playableAsset = timeline;
            playableDirector.playOnAwake = false;

            foreach ((JObject shot, GameObject cameraObject) in shots)
            {
                var track = timeline.CreateTrack<ActivationTrack>(null, (string)shot["title"] ?? "Shot");
                TimelineClip clip = track.CreateDefaultClip();
                clip.start = (double)shot["frameStart"] / fps;
                clip.duration = Math.Max(
                    1.0 / fps, ((double)shot["frameEnd"] - (double)shot["frameStart"]) / fps);
                playableDirector.SetGenericBinding(track, cameraObject);
            }

            foreach (AnimatedEntity entity in animated)
            {
                if (BakeEntity(entity, animated, byDirectorId, scene, fps, timeline, playableDirector, warnings))
                {
                    result.BakedAnimationClipCount += 1;
                }
            }

            AssetDatabase.SaveAssets();
            result.TimelinePath = timelinePath;
            return result;
        }

        private static List<AnimatedEntity> CollectAnimatedEntities(
            JObject project, Dictionary<string, GameObject> byDirectorId, List<string> warnings)
        {
            var animated = new List<AnimatedEntity>();
            foreach ((string collection, bool isCamera) in new[] { ("objects", false), ("cameras", true) })
            {
                foreach (JToken entityToken in (JArray)project[collection])
                {
                    var entity = (JObject)entityToken;
                    var animation = (JObject)entity["animation"];
                    bool followCamera = isCamera && (string)entity["action"]?["mode"] == "follow";
                    if (animation == null && !followCamera)
                    {
                        continue;
                    }
                    string directorId = (string)entity["id"];
                    if (!byDirectorId.TryGetValue(directorId, out GameObject gameObject))
                    {
                        continue;
                    }
                    var evaluator = new DirectorAnimationEvaluator(animation ?? new JObject());
                    foreach (string channel in evaluator.UnsupportedChannels)
                    {
                        warnings.Add(
                            $"Entity {directorId}: animation channel \"{channel}\" (Director-side rig/motion " +
                            "evaluation) is not baked to Unity (warn-and-omit).");
                    }
                    animated.Add(new AnimatedEntity
                    {
                        Entity = entity,
                        IsCamera = isCamera,
                        Evaluator = evaluator,
                        GameObject = gameObject,
                    });
                }
            }
            return animated;
        }

        private static List<(JObject Shot, GameObject Camera)> CollectShots(
            JObject project, Dictionary<string, GameObject> cameras)
        {
            var shots = new List<(JObject, GameObject)>();
            foreach (JToken shotToken in (JArray)(project["storyboard"]?["shots"] ?? new JArray()))
            {
                var shot = (JObject)shotToken;
                string cameraId = (string)shot["cameraId"];
                if (cameraId != null && cameras.TryGetValue(cameraId, out GameObject cameraObject))
                {
                    shots.Add((shot, cameraObject));
                }
            }
            return shots;
        }

        private static bool BakeEntity(
            AnimatedEntity entity,
            List<AnimatedEntity> allAnimated,
            Dictionary<string, GameObject> byDirectorId,
            JObject scene,
            double fps,
            TimelineAsset timeline,
            PlayableDirector playableDirector,
            List<string> warnings)
        {
            DirectorAnimationEvaluator evaluator = entity.Evaluator;
            string directorId = (string)entity.Entity["id"];
            bool followCamera = entity.IsCamera && (string)entity.Entity["action"]?["mode"] == "follow";
            bool hasChannels =
                evaluator.HasBakeableTransform || evaluator.HasFovChannel || evaluator.HasLookChannel || followCamera;
            if (!hasChannels || evaluator.FirstFrame == null && !followCamera)
            {
                return false;
            }

            (double firstFrame, double lastTimelineFrame) = BakeRange(entity, scene);
            if (lastTimelineFrame <= firstFrame && !followCamera)
            {
                // A single-frame animation still pins the pose; nothing to bake.
                return false;
            }

            if (entity.GameObject.transform.parent != null)
            {
                warnings.Add(
                    $"Entity {directorId}: animated entities bake world-space samples, so it was detached from " +
                    $"its Director parent \"{entity.GameObject.transform.parent.name}\" to keep the animation exact.");
                entity.GameObject.transform.SetParent(null, true);
            }

            double frameSpan = Math.Max(1.0, lastTimelineFrame - firstFrame);
            double step = 1.0;
            if (frameSpan / step > MaxSamplesPerEntity)
            {
                step = frameSpan / MaxSamplesPerEntity;
                warnings.Add(
                    $"Entity {directorId}: animation spans {frameSpan:0} frames; baked every {step:0.##} frames " +
                    $"to stay under {MaxSamplesPerEntity} samples.");
            }

            var clip = new AnimationClip { name = $"Director {entity.GameObject.name}", frameRate = (float)fps };
            var curves = new BakedCurves(entity.IsCamera);
            Camera camera = entity.IsCamera ? entity.GameObject.GetComponent<Camera>() : null;

            double[] previousQuaternion = null;
            for (double frame = firstFrame; ; frame += step)
            {
                double clamped = Math.Min(frame, lastTimelineFrame);
                float time = (float)((clamped - firstFrame) / fps);
                Sample sample = EvaluateSample(entity, allAnimated, byDirectorId, scene, clamped);

                // Keep the quaternion track on one cover of rotation space.
                if (previousQuaternion != null && Dot(sample.UnityQuaternion, previousQuaternion) < 0)
                {
                    for (int index = 0; index < 4; index += 1) sample.UnityQuaternion[index] = -sample.UnityQuaternion[index];
                }
                previousQuaternion = sample.UnityQuaternion;

                curves.AddTransformKey(time, sample);
                if (entity.IsCamera && sample.FovDegrees != null)
                {
                    curves.AddFovKey(time, sample.FovDegrees.Value, camera);
                }
                if (clamped >= lastTimelineFrame)
                {
                    break;
                }
            }

            curves.WriteInto(clip);
            clip.EnsureQuaternionContinuity();
            AssetDatabase.AddObjectToAsset(clip, timeline);

            var track = timeline.CreateTrack<AnimationTrack>(null, entity.GameObject.name);
            TimelineClip timelineClip = track.CreateClip(clip);
            timelineClip.start = firstFrame / fps;
            timelineClip.displayName = clip.name;
            Animator animator = entity.GameObject.GetComponent<Animator>();
            if (animator == null)
            {
                animator = entity.GameObject.AddComponent<Animator>();
            }
            playableDirector.SetGenericBinding(track, animator);
            return true;
        }

        private static (double FirstFrame, double LastTimelineFrame) BakeRange(AnimatedEntity entity, JObject scene)
        {
            double firstFrame = entity.Evaluator.FirstFrame ?? 0.0;
            double lastFrame = entity.Evaluator.LastFrame ?? firstFrame;
            JObject timeline = (JObject)scene["timeline"];
            if (entity.Evaluator.FirstFrame == null && timeline != null)
            {
                firstFrame = (double)timeline["frameStart"];
                lastFrame = (double)timeline["frameEnd"];
            }
            if (entity.IsCamera && (string)entity.Entity["action"]?["mode"] == "path")
            {
                // Path playback maps timeline frames onto authored frames with a
                // speed factor; extend the baked range so the whole path plays.
                double speed = Math.Max(0.1, (double?)entity.Entity["action"]?["path"]?["speed"] ?? 1.0);
                lastFrame = firstFrame + (lastFrame - firstFrame) / speed;
            }
            return (firstFrame, lastFrame);
        }

        private struct Sample
        {
            public Vector3 UnityPosition;
            public double[] UnityQuaternion;
            public Vector3 UnityScale;
            public double? FovDegrees;
        }

        /// <summary>
        /// One Director-frame sample in Unity space, mirroring the priority of
        /// evaluateDirectorCameraAtFrame / evaluateDirectorObjectAtFrame:
        /// follow overrides position+target; path lockTarget, waypoint object,
        /// and lookTarget keys override the camera aim; cameras always aim at
        /// their resolved target.
        /// </summary>
        private static Sample EvaluateSample(
            AnimatedEntity entity,
            List<AnimatedEntity> allAnimated,
            Dictionary<string, GameObject> byDirectorId,
            JObject scene,
            double timelineFrame)
        {
            double[] scenePosition = Vec3(scene["position"]);
            double[] sceneRotation = Vec3(scene["rotation"]);
            double sceneScale = (double)scene["scale"];
            JObject transform = (JObject)entity.Entity["transform"];
            double[] basePosition = Vec3(transform["position"]);
            double[] baseRotation = Vec3(transform["rotation"]);
            double[] baseScale = Vec3(transform["scale"]);

            JObject action = (JObject)entity.Entity["action"];
            string actionMode = (string)action?["mode"];
            double frame = entity.IsCamera
                ? entity.Evaluator.CameraAnimationFrame(
                    timelineFrame, actionMode, (double?)action?["path"]?["speed"])
                : timelineFrame;

            entity.Evaluator.EvaluateTransform(
                frame, basePosition, baseRotation, baseScale,
                out double[] localPosition, out double[] localRotationEuler, out double[] localScale);

            double[] worldTarget = null;
            if (entity.IsCamera)
            {
                if (actionMode == "follow")
                {
                    string followId = (string)action?["follow"]?["targetObjectId"];
                    double[] followPoint = ResolveEntityWorldPoint(allAnimated, byDirectorId, scene, followId, timelineFrame);
                    if (followPoint != null)
                    {
                        double[] positionOffset = Vec3(action["follow"]["positionOffset"]);
                        double[] targetOffset = Vec3(action["follow"]["targetOffset"]);
                        double[] worldOffsetPosition = AddVec3(followPoint, positionOffset);
                        worldTarget = AddVec3(followPoint, targetOffset);
                        return ComposeCameraSample(
                            entity, scene, worldOffsetPosition, localRotationEuler, localScale, worldTarget, frame,
                            worldIsCanonical: true);
                    }
                }

                string lockTargetId =
                    actionMode == "path" && action?["path"]?["lockTarget"] != null &&
                    (bool)action["path"]["lockTarget"]
                        ? (string)action["path"]["targetObjectId"]
                        : null;
                worldTarget = ResolveEntityWorldPoint(allAnimated, byDirectorId, scene, lockTargetId, timelineFrame);
                if (worldTarget == null)
                {
                    string waypointId = entity.Evaluator.EvaluateWaypointTargetObjectId(frame);
                    worldTarget = ResolveEntityWorldPoint(allAnimated, byDirectorId, scene, waypointId, timelineFrame);
                }
                if (worldTarget == null)
                {
                    double[] lookTarget = entity.Evaluator.EvaluateLookTarget(frame);
                    if (lookTarget != null)
                    {
                        worldTarget = DirectorSpace.ComposeWorldPoint(
                            scenePosition, sceneRotation, sceneScale, lookTarget);
                    }
                }
                if (worldTarget == null)
                {
                    string staticTargetId =
                        (string)entity.Entity["targetMode"] == "object"
                            ? (string)entity.Entity["targetObjectId"]
                            : null;
                    worldTarget =
                        ResolveEntityWorldPoint(allAnimated, byDirectorId, scene, staticTargetId, timelineFrame) ??
                        DirectorSpace.ComposeWorldPoint(
                            scenePosition, sceneRotation, sceneScale, Vec3(entity.Entity["target"]));
                }
            }

            return ComposeCameraSample(
                entity, scene, localPosition, localRotationEuler, localScale, worldTarget, frame,
                worldIsCanonical: false);
        }

        private static Sample ComposeCameraSample(
            AnimatedEntity entity,
            JObject scene,
            double[] position,
            double[] localRotationEuler,
            double[] localScale,
            double[] worldTarget,
            double frame,
            bool worldIsCanonical)
        {
            double[] scenePosition = Vec3(scene["position"]);
            double[] sceneRotation = Vec3(scene["rotation"]);
            double sceneScale = (double)scene["scale"];

            double[] worldPosition;
            double[] worldQuaternion;
            double[] worldScale;
            if (worldIsCanonical)
            {
                worldPosition = position;
                worldQuaternion = DirectorSpace.QuaternionFromEulerXyz(
                    localRotationEuler[0], localRotationEuler[1], localRotationEuler[2]);
                worldScale = localScale;
            }
            else
            {
                DirectorSpace.ComposeWorldTransform(
                    scenePosition, sceneRotation, sceneScale,
                    position,
                    DirectorSpace.QuaternionFromEulerXyz(
                        localRotationEuler[0], localRotationEuler[1], localRotationEuler[2]),
                    localScale,
                    out worldPosition, out worldQuaternion, out worldScale);
            }

            if (entity.IsCamera && worldTarget != null)
            {
                worldQuaternion = DirectorCameraImport.LookOrFallback(worldPosition, worldTarget, worldQuaternion);
            }

            Quaternion unityQuaternion = DirectorSpace.DirectorQuaternionToUnity(
                worldQuaternion[0], worldQuaternion[1], worldQuaternion[2], worldQuaternion[3]);
            var sample = new Sample
            {
                UnityPosition = DirectorSpace.DirectorPointToUnity(worldPosition[0], worldPosition[1], worldPosition[2]),
                UnityQuaternion = new double[]
                {
                    unityQuaternion.x, unityQuaternion.y, unityQuaternion.z, unityQuaternion.w,
                },
                UnityScale = DirectorSpace.DirectorScaleToUnity(worldScale[0], worldScale[1], worldScale[2]),
                FovDegrees = null,
            };
            if (entity.IsCamera)
            {
                sample.FovDegrees = entity.Evaluator.EvaluateFov(frame) ?? (double)entity.Entity["fov"];
            }
            return sample;
        }

        /// <summary>
        /// World position of another Director entity at a timeline frame,
        /// resolved strictly by id: an animated entity evaluates through its
        /// own evaluator, a static entity uses its authored transform.
        /// </summary>
        private static double[] ResolveEntityWorldPoint(
            List<AnimatedEntity> allAnimated,
            Dictionary<string, GameObject> byDirectorId,
            JObject scene,
            string directorId,
            double timelineFrame)
        {
            if (directorId == null)
            {
                return null;
            }
            foreach (AnimatedEntity candidate in allAnimated)
            {
                if ((string)candidate.Entity["id"] != directorId)
                {
                    continue;
                }
                JObject transform = (JObject)candidate.Entity["transform"];
                candidate.Evaluator.EvaluateTransform(
                    timelineFrame,
                    Vec3(transform["position"]), Vec3(transform["rotation"]), Vec3(transform["scale"]),
                    out double[] localPosition, out _, out _);
                return DirectorSpace.ComposeWorldPoint(
                    Vec3(scene["position"]), Vec3(scene["rotation"]), (double)scene["scale"], localPosition);
            }
            // Static entities: read their imported GameObject position back in
            // canonical space, so Director parenting stays accounted for.
            if (byDirectorId.TryGetValue(directorId, out GameObject staticEntity))
            {
                return DirectorSpace.UnityPointToDirector(staticEntity.transform.position);
            }
            return null;
        }

        /// <summary>Accumulates per-property keyframes and writes them into an AnimationClip.</summary>
        private sealed class BakedCurves
        {
            private readonly List<Keyframe>[] _position = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private readonly List<Keyframe>[] _rotation = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private readonly List<Keyframe>[] _scale = { new List<Keyframe>(), new List<Keyframe>(), new List<Keyframe>() };
            private readonly List<Keyframe> _fov = new List<Keyframe>();
            private bool _fovIsFocalLength;
            private double _usedSensorHeight = 24.0;
            private readonly bool _isCamera;

            public BakedCurves(bool isCamera)
            {
                _isCamera = isCamera;
            }

            public void AddTransformKey(float time, Sample sample)
            {
                _position[0].Add(new Keyframe(time, sample.UnityPosition.x));
                _position[1].Add(new Keyframe(time, sample.UnityPosition.y));
                _position[2].Add(new Keyframe(time, sample.UnityPosition.z));
                for (int index = 0; index < 4; index += 1)
                {
                    _rotation[index].Add(new Keyframe(time, (float)sample.UnityQuaternion[index]));
                }
                _scale[0].Add(new Keyframe(time, sample.UnityScale.x));
                _scale[1].Add(new Keyframe(time, sample.UnityScale.y));
                _scale[2].Add(new Keyframe(time, sample.UnityScale.z));
            }

            public void AddFovKey(float time, double fovDegrees, Camera camera)
            {
                if (camera != null && camera.usePhysicalProperties)
                {
                    // Physical cameras derive fov from focal length, so the fov
                    // channel bakes onto m_FocalLength through the used gate.
                    _fovIsFocalLength = true;
                    _usedSensorHeight = camera.sensorSize.y;
                    double focal = _usedSensorHeight / (2.0 * Math.Tan(fovDegrees * Math.PI / 360.0));
                    _fov.Add(new Keyframe(time, (float)focal));
                }
                else
                {
                    _fov.Add(new Keyframe(time, (float)fovDegrees));
                }
            }

            public void WriteInto(AnimationClip clip)
            {
                string[] positionProperties = { "localPosition.x", "localPosition.y", "localPosition.z" };
                string[] rotationProperties = { "localRotation.x", "localRotation.y", "localRotation.z", "localRotation.w" };
                string[] scaleProperties = { "localScale.x", "localScale.y", "localScale.z" };
                for (int index = 0; index < 3; index += 1)
                {
                    clip.SetCurve(string.Empty, typeof(Transform), positionProperties[index], new AnimationCurve(_position[index].ToArray()));
                    clip.SetCurve(string.Empty, typeof(Transform), scaleProperties[index], new AnimationCurve(_scale[index].ToArray()));
                }
                for (int index = 0; index < 4; index += 1)
                {
                    clip.SetCurve(string.Empty, typeof(Transform), rotationProperties[index], new AnimationCurve(_rotation[index].ToArray()));
                }
                if (_isCamera && _fov.Count > 0)
                {
                    clip.SetCurve(
                        string.Empty,
                        typeof(Camera),
                        _fovIsFocalLength ? "m_FocalLength" : "field of view",
                        new AnimationCurve(_fov.ToArray()));
                }
            }
        }

        private static double Dot(double[] left, double[] right)
        {
            return left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3];
        }

        private static double[] AddVec3(double[] left, double[] right)
        {
            return new[] { left[0] + right[0], left[1] + right[1], left[2] + right[2] };
        }

        private static double[] Vec3(JToken token)
        {
            return new[] { (double)token[0], (double)token[1], (double)token[2] };
        }
    }
}
