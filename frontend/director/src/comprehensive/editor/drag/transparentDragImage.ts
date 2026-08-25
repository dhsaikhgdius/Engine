let transparentDragImage: HTMLCanvasElement | null = null;

function getTransparentDragImage() {
  if (!transparentDragImage) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    transparentDragImage = canvas;
  }

  return transparentDragImage;
}

/** Hides the browser's native light drag ghost so the workspace owns the feedback UI. */
export function setTransparentDragImage(dataTransfer: DataTransfer) {
  if (typeof dataTransfer.setDragImage !== "function") return;
  dataTransfer.setDragImage(getTransparentDragImage(), 0, 0);
}
