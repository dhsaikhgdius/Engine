import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  DIRECTOR_INTERCHANGE_CONTRACT,
  DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
  createDirectorInterchangeManifest,
  exportDirectorProjectToGltf,
  exportDirectorProjectToUsda,
  parseDirectorInterchangeManifest,
} from "../../../../src/comprehensive/editor/interchange/index";

function projectWithAssetlessCharacter() {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((object) => object.kind === "character")!;
  delete character.assetRefId;
  return project;
}

describe("Director interchange character asset boundaries", () => {
  it("rejects assetless characters at the shared manifest boundary", () => {
    const project = projectWithAssetlessCharacter();

    expect(() => createDirectorInterchangeManifest(project)).toThrow(
      "Director interchange character asset binding is invalid",
    );
    expect(() =>
      parseDirectorInterchangeManifest({
        contract: DIRECTOR_INTERCHANGE_CONTRACT,
        version: 1,
        coordinateSystem: DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
        project,
      }),
    ).toThrow("Director interchange character asset binding is invalid");
  });

  it("does not serialize an assetless character through glTF or USD", async () => {
    const project = projectWithAssetlessCharacter();

    await expect(exportDirectorProjectToGltf(project)).rejects.toThrow(
      "Director interchange character asset binding is invalid",
    );
    expect(() => exportDirectorProjectToUsda(project)).toThrow(
      "Director interchange character asset binding is invalid",
    );
  });
});
