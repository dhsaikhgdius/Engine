import { create } from "zustand";
import type { DirectorVideoRecording } from "./directorVideoExport";

export const MAX_DIRECTOR_VIDEO_LIBRARY_ITEMS = 24;
export const MAX_DIRECTOR_VIDEO_LIBRARY_BYTES = 512 * 1024 * 1024;

/** The upload/transfer status of a video library item. */
export type DirectorVideoLibraryStatus = "ready" | "uploading" | "uploaded" | "error";

/** A recorded video in the local library, with metadata and upload status. */
export interface DirectorVideoLibraryItem extends DirectorVideoRecording {
  id: string;
  index: number;
  name: string;
  fileName: string;
  createdAt: string;
  status: DirectorVideoLibraryStatus;
  statusMessage: string;
}

interface DirectorVideoRecordingState {
  recordings: DirectorVideoLibraryItem[];
  addRecording: (recording: DirectorVideoRecording) => DirectorVideoLibraryItem;
  removeRecording: (recordingId: string) => void;
  clearRecordings: () => void;
  updateRecordingStatus: (recordingId: string, status: DirectorVideoLibraryStatus, statusMessage?: string) => void;
  reset: () => void;
}

let nextRecordingIndex = 1;

function createRecordingId(index: number) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `director-video-${globalThis.crypto.randomUUID()}`;
  }
  return `director-video-${Date.now()}-${index}`;
}

function fitRecordingLibrary(recordings: DirectorVideoLibraryItem[]) {
  const fitted = recordings.slice(-MAX_DIRECTOR_VIDEO_LIBRARY_ITEMS);
  let totalBytes = fitted.reduce((total, item) => total + item.blob.size, 0);
  while (fitted.length > 1 && totalBytes > MAX_DIRECTOR_VIDEO_LIBRARY_BYTES) {
    totalBytes -= fitted.shift()!.blob.size;
  }
  return fitted;
}

export const useVideoRecordingStore = create<DirectorVideoRecordingState>((set) => ({
  recordings: [],
  addRecording: (recording) => {
    if (recording.blob.size > MAX_DIRECTOR_VIDEO_LIBRARY_BYTES) {
      throw new Error("渲染视频超过 512 MiB 的页面会话安全上限");
    }
    const index = nextRecordingIndex;
    nextRecordingIndex += 1;
    const name = `渲染视频${String(index).padStart(2, "0")}`;
    const item: DirectorVideoLibraryItem = {
      ...recording,
      id: createRecordingId(index),
      index,
      name,
      fileName: `director-render-${String(index).padStart(2, "0")}-f${recording.frameStart}-f${recording.frameEnd}.${recording.extension}`,
      createdAt: new Date().toISOString(),
      status: "ready",
      statusMessage: "可下载或发送到 ComfyUI",
    };
    set((state) => ({ recordings: fitRecordingLibrary([...state.recordings, item]) }));
    return item;
  },
  removeRecording: (recordingId) =>
    set((state) => ({
      recordings: state.recordings.filter((item) => item.id !== recordingId),
    })),
  clearRecordings: () => set({ recordings: [] }),
  updateRecordingStatus: (recordingId, status, statusMessage = "") =>
    set((state) => ({
      recordings: state.recordings.map((item) => (item.id === recordingId ? { ...item, status, statusMessage } : item)),
    })),
  reset: () => {
    nextRecordingIndex = 1;
    set({ recordings: [] });
  },
}));
