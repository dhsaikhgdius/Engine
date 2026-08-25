import { describe, expect, it } from "vitest";
import { inspectComfyWorkflow, patchComfyWorkflow } from "../../generation/comfyWorkflow";

const workflow = {
  "1": {
    class_type: "CLIPTextEncode",
    inputs: { text: "old positive", clip: ["6", 1] },
    _meta: { title: "Positive Prompt" },
  },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { text: "old negative", clip: ["6", 1] },
    _meta: { title: "Negative Prompt" },
  },
  "3": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "4": {
    class_type: "KSampler",
    inputs: {
      seed: 7,
      steps: 20,
      cfg: 7.5,
      sampler_name: "euler",
      scheduler: "normal",
      model: ["6", 0],
    },
  },
  "6": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
};

describe("ComfyUI workflow inspection and patching", () => {
  it("extracts typed editable parameters and semantic bindings from API workflow JSON", () => {
    const inspection = inspectComfyWorkflow(workflow, "image");
    expect(inspection.nodeCount).toBe(5);
    expect(inspection.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "1.text", semantic: "prompt", type: "text" }),
        expect.objectContaining({ id: "2.text", semantic: "negative_prompt" }),
        expect.objectContaining({ id: "3.width", semantic: "width", type: "integer" }),
        expect.objectContaining({ id: "4.seed", semantic: "seed", type: "integer" }),
        expect.objectContaining({ id: "6.ckpt_name", semantic: "model", type: "model" }),
      ]),
    );
    expect(inspection.parameters.some((parameter) => parameter.id === "4.model")).toBe(false);
  });

  it("reports node classes not advertised by the selected runtime", () => {
    const inspection = inspectComfyWorkflow(workflow, "image", new Set(["CLIPTextEncode", "KSampler"]));
    expect(inspection.unsupportedClassTypes).toEqual(["CheckpointLoaderSimple", "EmptyLatentImage"]);
  });

  it("patches semantic values, explicit technical overrides, and legacy template tokens without mutating the source", () => {
    const tokenWorkflow = structuredClone(workflow);
    tokenWorkflow["1"].inputs.text = "{{PROMPT}}";
    const inspection = inspectComfyWorkflow(tokenWorkflow, "image");
    const patched = patchComfyWorkflow(tokenWorkflow, inspection.parameters, {
      prompt: "rain-soaked neon alley",
      negativePrompt: "flicker",
      width: 1280,
      height: 720,
      seed: 42,
      parameters: { "4.steps": 32, "4.sampler_name": "dpmpp_2m" },
    });
    expect(patched["1"]?.inputs.text).toBe("rain-soaked neon alley");
    expect(patched["2"]?.inputs.text).toBe("flicker");
    expect(patched["3"]?.inputs).toMatchObject({ width: 1280, height: 720 });
    expect(patched["4"]?.inputs).toMatchObject({ seed: 42, steps: 32, sampler_name: "dpmpp_2m" });
    expect(tokenWorkflow["4"].inputs.steps).toBe(20);
    expect(() =>
      patchComfyWorkflow(workflow, inspection.parameters, {
        prompt: "test",
        width: 512,
        height: 512,
        seed: 1,
        parameters: { "99.typo": 1 },
      }),
    ).toThrow(/not exposed/);
  });

  it("discovers and patches provider-neutral audio workflow controls", () => {
    const audioWorkflow = {
      "1": {
        class_type: "TextToAudio",
        inputs: {
          prompt: "old sound",
          duration_seconds: 4,
          sample_rate: 44_100,
          voice: "default",
          language: "en",
          audio_mode: "sound-effect",
          seed: 1,
        },
      },
      "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
    };
    const inspection = inspectComfyWorkflow(audioWorkflow, "audio");
    expect(inspection.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "1.prompt", semantic: "prompt" }),
        expect.objectContaining({ id: "1.duration_seconds", semantic: "duration_seconds" }),
        expect.objectContaining({ id: "1.sample_rate", semantic: "sample_rate" }),
        expect.objectContaining({ id: "1.voice", semantic: "voice" }),
        expect.objectContaining({ id: "1.audio_mode", semantic: "audio_mode" }),
      ]),
    );
    const patched = patchComfyWorkflow(audioWorkflow, inspection.parameters, {
      prompt: "close thunder rolling across a valley",
      width: 1_024,
      height: 1_024,
      seed: 12,
      durationSeconds: 9,
      sampleRate: 48_000,
      voice: "narrator-a",
      language: "zh",
      audioMode: "speech",
    });
    expect(patched["1"]?.inputs).toMatchObject({
      prompt: "close thunder rolling across a valley",
      duration_seconds: 9,
      sample_rate: 48_000,
      voice: "narrator-a",
      language: "zh",
      audio_mode: "speech",
      seed: 12,
    });
  });
});
