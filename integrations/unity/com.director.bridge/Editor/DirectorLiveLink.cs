using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CSharp;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Outbound-only Unity editor client for Director's live preview link.
    ///
    /// The client long-polls the Director Gateway's live-link event feed with
    /// the per-session bearer token minted by Director; the gateway never
    /// connects into Unity. Besides preview state, an explicitly granted
    /// workshop session can capture, execute C#, and snapshot the open scene.
    ///
    /// Director-authority sessions remain transient. Engine-authority
    /// sessions can return a stable-id review snapshot without flattening
    /// prefabs, colliders, scripts, navigation, or UI out of the Unity project.
    ///
    /// Delivery is sequence-numbered: the client resumes each poll after the
    /// last applied sequence number, and when the gateway signals a gap
    /// (`resync: true`) the preview rebuilds from the delivered snapshot.
    /// Network failures back off and retry; 401/404/410 stop the link with a
    /// human-readable status because the session is gone for good.
    /// </summary>
    public sealed class DirectorLiveLinkClient
    {
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(90);
        private const int LongPollWaitMs = 25_000;
        private const int MaxBackoffMs = 10_000;

        private HttpClient _http;
        private CancellationTokenSource _cancellation;
        private string _commandResultUrl;
        private readonly Dictionary<string, DirectorId> _entitiesByDirectorId =
            new Dictionary<string, DirectorId>();

        /// <summary>Human-readable connection status for the editor window.</summary>
        public string StatusLine { get; private set; } = "Not connected.";

        /// <summary>Sequence number of the last applied event.</summary>
        public long LastAppliedSeq { get; private set; }

        /// <summary>True while the poll loop is running.</summary>
        public bool Running => _cancellation != null && !_cancellation.IsCancellationRequested;

        /// <summary>
        /// Starts the outbound poll loop against one live-link session. The
        /// gateway URL, session id, and token come from Director's
        /// POST /api/dcc/unity/live-link/sessions response.
        /// </summary>
        public void Connect(string gatewayUrl, string sessionId, string token)
        {
            Disconnect();
            if (string.IsNullOrWhiteSpace(gatewayUrl) || string.IsNullOrWhiteSpace(sessionId) ||
                string.IsNullOrWhiteSpace(token))
            {
                StatusLine = "Gateway URL, session id, and token are all required.";
                return;
            }
            string baseUrl = gatewayUrl.Trim().TrimEnd('/');
            string pollUrl = $"{baseUrl}/api/dcc/unity/live-link/sessions/{Uri.EscapeDataString(sessionId.Trim())}/events";
            _commandResultUrl = $"{baseUrl}/api/dcc/unity/live-link/sessions/{Uri.EscapeDataString(sessionId.Trim())}/command-results";
            _http = new HttpClient { Timeout = RequestTimeout };
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
            _cancellation = new CancellationTokenSource();
            LastAppliedSeq = 0;
            StatusLine = "Connecting…";
            _ = PollLoop(pollUrl, _cancellation.Token);
        }

        /// <summary>Stops the poll loop and releases the HTTP client.</summary>
        public void Disconnect()
        {
            _cancellation?.Cancel();
            _cancellation?.Dispose();
            _cancellation = null;
            _http?.Dispose();
            _http = null;
            _commandResultUrl = null;
            _entitiesByDirectorId.Clear();
            StatusLine = "Not connected.";
        }

        private async Task PollLoop(string pollUrl, CancellationToken cancellationToken)
        {
            int backoffMs = 1_000;
            while (!cancellationToken.IsCancellationRequested)
            {
                string body;
                int statusCode;
                HttpClient http = _http;
                if (http == null) return;
                try
                {
                    // Editor await continuations resume on the main thread, so
                    // event application below is main-thread safe.
                    HttpResponseMessage response = await http.GetAsync(
                        $"{pollUrl}?after={LastAppliedSeq}&wait_ms={LongPollWaitMs}", cancellationToken);
                    statusCode = (int)response.StatusCode;
                    body = await response.Content.ReadAsStringAsync();
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    // Disconnect() disposed the client while a poll was in flight.
                    return;
                }
                catch (HttpRequestException error)
                {
                    StatusLine = $"Gateway unreachable ({error.Message}); retrying in {backoffMs / 1000.0:0.#}s.";
                    try
                    {
                        await Task.Delay(backoffMs, cancellationToken);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    backoffMs = Math.Min(backoffMs * 2, MaxBackoffMs);
                    continue;
                }

                if (cancellationToken.IsCancellationRequested) return;
                if (statusCode == 401 || statusCode == 404 || statusCode == 410)
                {
                    string terminalStatus = statusCode == 410
                        ? "Live-link session was closed by Director."
                        : statusCode == 404
                            ? "Live-link session is unknown or expired."
                            : "Live-link token was rejected.";
                    Disconnect();
                    StatusLine = $"{terminalStatus} Create a new session in Director to reconnect.";
                    return;
                }
                if (statusCode != 200)
                {
                    StatusLine = $"Gateway answered HTTP {statusCode}; retrying in {backoffMs / 1000.0:0.#}s.";
                    try
                    {
                        await Task.Delay(backoffMs, cancellationToken);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    backoffMs = Math.Min(backoffMs * 2, MaxBackoffMs);
                    continue;
                }
                backoffMs = 1_000;

                JObject result;
                try
                {
                    result = (JObject)JObject.Parse(body)["result"];
                }
                catch (Exception error)
                {
                    StatusLine = $"Unreadable live-link response: {error.Message}";
                    continue;
                }
                if (result == null) continue;
                bool resync = result["resync"] != null && (bool)result["resync"];
                if (resync)
                {
                    // The requested tail was evicted gateway-side: the
                    // delivered events start with the latest snapshot, so the
                    // stale lookup cache is dropped before rebuilding.
                    _entitiesByDirectorId.Clear();
                }
                var events = (JArray)result["events"] ?? new JArray();
                foreach (JToken eventToken in events)
                {
                    ApplyEvent((JObject)eventToken);
                }
                LastAppliedSeq = (long?)result["latestSeq"] ?? LastAppliedSeq;
                StatusLine = $"Live (seq {LastAppliedSeq}{(resync ? ", resynced" : string.Empty)}).";
            }
        }

        private void ApplyEvent(JObject eventObject)
        {
            var payload = (JObject)eventObject["payload"];
            string kind = (string)payload?["kind"];
            if (kind == "snapshot" || kind == "transform_update")
            {
                foreach (JToken entityToken in (JArray)(payload["entities"] ?? new JArray()))
                {
                    ApplyEntityState((JObject)entityToken);
                }
                return;
            }
            if (kind == "timeline_update")
            {
                // Timeline scrub state is surfaced but not applied: the baked
                // Timeline asset owns playback inside Unity.
                StatusLine = $"Director playhead at frame {(double?)payload["frame"] ?? 0}.";
                return;
            }
            if (kind == "editor_command")
            {
                string command = (string)payload["command"];
                if (command == "capture_frame") ExecuteCaptureCommand(payload);
                else if (command == "execute_code") ExecuteCodeCommand(payload);
                else if (command == "sync_scene") ExecuteSyncCommand(payload);
            }
        }

        private void ExecuteCaptureCommand(JObject payload)
        {
            string commandId = (string)payload["commandId"];
            if (string.IsNullOrWhiteSpace(commandId)) return;
            JObject result;
            try
            {
                int width = Math.Max(64, Math.Min(1920, (int?)payload["width"] ?? 960));
                int height = Math.Max(64, Math.Min(1080, (int?)payload["height"] ?? 540));
                string camera = (string)payload["camera"];
                byte[] png = DirectorBridgeCli.CaptureFrame(camera, width, height);
                result = new JObject
                {
                    ["commandId"] = commandId,
                    ["command"] = "capture_frame",
                    ["status"] = "completed",
                    ["mimeType"] = "image/png",
                    ["imageBase64"] = Convert.ToBase64String(png),
                    ["width"] = width,
                    ["height"] = height,
                };
            }
            catch (Exception error)
            {
                result = new JObject
                {
                    ["commandId"] = commandId,
                    ["command"] = "capture_frame",
                    ["status"] = "failed",
                    ["error"] = error.Message,
                };
            }
            _ = SubmitCommandResult(result);
        }

        private void ExecuteCodeCommand(JObject payload)
        {
            string commandId = (string)payload["commandId"];
            if (string.IsNullOrWhiteSpace(commandId)) return;
            JObject result;
            try
            {
                string code = (string)payload["code"] ?? string.Empty;
                string source =
                    "using System; using System.Linq; using UnityEditor; using UnityEngine; " +
                    "public static class DirectorEngineSessionCommand { public static object Run() {\n" +
                    code + "\nreturn null; } }";
                using (var provider = new CSharpCodeProvider())
                {
                    var parameters = new CompilerParameters { GenerateExecutable = false, GenerateInMemory = true };
                    foreach (string assemblyPath in AppDomain.CurrentDomain.GetAssemblies()
                                 .Where(assembly => !assembly.IsDynamic && !string.IsNullOrWhiteSpace(assembly.Location))
                                 .Select(assembly => assembly.Location)
                                 .Distinct())
                    {
                        parameters.ReferencedAssemblies.Add(assemblyPath);
                    }
                    CompilerResults compiled = provider.CompileAssemblyFromSource(parameters, source);
                    if (compiled.Errors.HasErrors)
                    {
                        string errors = string.Join("\n", compiled.Errors.Cast<CompilerError>()
                            .Where(error => !error.IsWarning).Select(error => error.ToString()));
                        throw new InvalidOperationException(errors);
                    }
                    object value = compiled.CompiledAssembly
                        .GetType("DirectorEngineSessionCommand", true)
                        .GetMethod("Run")
                        .Invoke(null, null);
                    string output;
                    try
                    {
                        output = value == null
                            ? "null"
                            : JToken.FromObject(value).ToString(Newtonsoft.Json.Formatting.None);
                    }
                    catch
                    {
                        output = value?.ToString() ?? "null";
                    }
                    result = new JObject
                    {
                        ["commandId"] = commandId,
                        ["command"] = "execute_code",
                        ["status"] = "completed",
                        ["output"] = output.Length > 131072 ? output.Substring(0, 131072) : output,
                    };
                }
            }
            catch (Exception error)
            {
                result = new JObject
                {
                    ["commandId"] = commandId,
                    ["command"] = "execute_code",
                    ["status"] = "failed",
                    ["error"] = error.GetBaseException().Message,
                };
            }
            _ = SubmitCommandResult(result);
        }

        private void ExecuteSyncCommand(JObject payload)
        {
            string commandId = (string)payload["commandId"];
            if (string.IsNullOrWhiteSpace(commandId)) return;
            JObject result;
            try
            {
                var entities = new JArray();
                foreach (DirectorId marker in UnityEngine.Object.FindObjectsByType<DirectorId>(
                             FindObjectsInactive.Include, FindObjectsSortMode.None))
                {
                    if (marker == null || string.IsNullOrWhiteSpace(marker.directorId)) continue;
                    Transform transform = marker.transform;
                    string entityType = marker.entityType == "camera" || marker.entityType == "light"
                        ? marker.entityType
                        : "object";
                    var entity = new JObject
                    {
                        ["directorId"] = marker.directorId,
                        ["name"] = marker.gameObject.name,
                        ["entityType"] = entityType,
                        ["transform"] = new JObject
                        {
                            ["location"] = JArray.FromObject(DirectorSpace.UnityPointToDirector(transform.position)),
                            ["rotationQuaternion"] = JArray.FromObject(
                                DirectorSpace.UnityQuaternionToDirector(transform.rotation)),
                            ["scale"] = JArray.FromObject(DirectorSpace.UnityScaleToDirector(transform.lossyScale)),
                        },
                    };
                    Camera camera = marker.GetComponent<Camera>();
                    if (entityType == "camera" && camera != null) entity["fovDegrees"] = camera.fieldOfView;
                    entities.Add(entity);
                }
                result = new JObject
                {
                    ["commandId"] = commandId,
                    ["command"] = "sync_scene",
                    ["status"] = "completed",
                    ["snapshot"] = new JObject
                    {
                        ["provider"] = "unity",
                        ["scenePath"] = string.IsNullOrWhiteSpace(SceneManager.GetActiveScene().path)
                            ? null
                            : SceneManager.GetActiveScene().path,
                        ["capturedAt"] = DateTime.UtcNow.ToString("O"),
                        ["entities"] = entities,
                    },
                };
            }
            catch (Exception error)
            {
                result = new JObject
                {
                    ["commandId"] = commandId,
                    ["command"] = "sync_scene",
                    ["status"] = "failed",
                    ["error"] = error.Message,
                };
            }
            _ = SubmitCommandResult(result);
        }

        private async Task SubmitCommandResult(JObject result)
        {
            HttpClient http = _http;
            CancellationTokenSource cancellation = _cancellation;
            string resultUrl = _commandResultUrl;
            if (http == null || cancellation == null || string.IsNullOrWhiteSpace(resultUrl)) return;
            try
            {
                using (var content = new StringContent(
                           result.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json"))
                {
                    using (HttpResponseMessage response = await http.PostAsync(resultUrl, content, cancellation.Token))
                    {
                        if (!response.IsSuccessStatusCode)
                        {
                            StatusLine = $"Engine command result rejected (HTTP {(int)response.StatusCode}).";
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Disconnect owns cancellation; there is no result to retry.
            }
            catch (Exception error)
            {
                StatusLine = $"Engine command result upload failed: {error.Message}";
            }
        }

        private void ApplyEntityState(JObject entityState)
        {
            string directorId = (string)entityState["directorId"];
            if (directorId == null) return;
            DirectorId marker = ResolveEntity(directorId);
            if (marker == null) return;

            var transform = (JObject)entityState["transform"];
            JToken location = transform["location"];
            JToken quaternion = transform["rotationQuaternion"];
            JToken scale = transform["scale"];
            marker.transform.SetPositionAndRotation(
                DirectorSpace.DirectorPointToUnity((double)location[0], (double)location[1], (double)location[2]),
                DirectorSpace.DirectorQuaternionToUnity(
                    (double)quaternion[0], (double)quaternion[1], (double)quaternion[2], (double)quaternion[3]));
            marker.transform.localScale = DirectorSpace.DirectorScaleToUnity(
                (double)scale[0], (double)scale[1], (double)scale[2]);

            if (entityState["fovDegrees"] != null)
            {
                Camera camera = marker.GetComponent<Camera>();
                if (camera != null)
                {
                    camera.fieldOfView = (float)(double)entityState["fovDegrees"];
                }
            }
        }

        private DirectorId ResolveEntity(string directorId)
        {
            if (_entitiesByDirectorId.TryGetValue(directorId, out DirectorId cached) && cached != null)
            {
                return cached;
            }
            foreach (DirectorId marker in UnityEngine.Object.FindObjectsByType<DirectorId>(
                         FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                _entitiesByDirectorId[marker.directorId] = marker;
            }
            return _entitiesByDirectorId.TryGetValue(directorId, out DirectorId resolved) ? resolved : null;
        }
    }

    /// <summary>
    /// Minimal editor window to connect the live preview link: paste the
    /// gateway URL, session id, and token from Director's session response.
    /// </summary>
    public sealed class DirectorLiveLinkWindow : EditorWindow
    {
        private readonly DirectorLiveLinkClient _client = new DirectorLiveLinkClient();
        private string _gatewayUrl = "http://127.0.0.1:8787";
        private string _sessionId = string.Empty;
        private string _token = string.Empty;

        [MenuItem("Director/Live Link Preview")]
        private static void Open()
        {
            GetWindow<DirectorLiveLinkWindow>("Director Live Link");
        }

        private void OnGUI()
        {
            EditorGUILayout.HelpBox(
                "Live session: Director streams preview transforms. An explicitly granted workshop session may " +
                "capture, execute C#, or return a stable-id review snapshot. Unity remains authoritative in engine mode.",
                MessageType.Info);
            using (new EditorGUI.DisabledScope(_client.Running))
            {
                _gatewayUrl = EditorGUILayout.TextField("Gateway URL", _gatewayUrl);
                _sessionId = EditorGUILayout.TextField("Session id", _sessionId);
                _token = EditorGUILayout.PasswordField("Token", _token);
            }
            if (!_client.Running && GUILayout.Button("Connect"))
            {
                _client.Connect(_gatewayUrl, _sessionId, _token);
            }
            if (_client.Running && GUILayout.Button("Disconnect"))
            {
                _client.Disconnect();
            }
            EditorGUILayout.LabelField(_client.StatusLine, EditorStyles.wordWrappedLabel);
            if (_client.Running) Repaint();
        }

        private void OnDisable()
        {
            _client.Disconnect();
        }
    }
}
