using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Outbound-only Unity editor client for Director's live preview link.
    ///
    /// The client long-polls the Director Gateway's live-link event feed with
    /// the per-session bearer token minted by Director; the gateway never
    /// connects into Unity and no event can carry executable code — the
    /// payload schema is fixed to snapshot / transform_update /
    /// timeline_update preview data validated gateway-side.
    ///
    /// The link is never authoritative: events move DirectorId-tagged scene
    /// objects as a transient preview (the scene is never marked dirty and
    /// nothing is written back to Director). Authoritative changes still
    /// travel exclusively through hash-checked exchange/return packages.
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
                "Preview-only link: Director streams entity transforms into this scene. Nothing is written back " +
                "and the scene is never saved by the link.",
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
