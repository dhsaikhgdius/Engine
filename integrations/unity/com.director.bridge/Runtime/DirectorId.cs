using UnityEngine;

namespace Director.Bridge
{
    /// <summary>
    /// Stable Director identity for a GameObject that round-trips between
    /// Director and Unity. Names are labels; this id is the join key.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class DirectorId : MonoBehaviour
    {
        [Tooltip("Stable director_id assigned by Director. Do not edit by hand.")]
        public string directorId = string.Empty;

        [Tooltip("Director entity type: object or camera.")]
        public string entityType = "object";
    }
}
