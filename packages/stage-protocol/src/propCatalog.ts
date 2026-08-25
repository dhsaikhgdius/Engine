/** Definition of a prop in the Stage catalog, including its key, label, category, color, and default dimensions. */
export interface PropDefinition {
  key: string;
  label: string;
  category: string;
  color: string;
  dimensions: [number, number, number];
}

/** The static catalog of built-in Stage props available for quick placement. */
export const PROP_CATALOG: PropDefinition[] = [
  { key: "chair", label: "椅子", category: "家具", color: "#8a6848", dimensions: [0.7, 1, 0.7] },
  { key: "table", label: "桌子", category: "家具", color: "#77573f", dimensions: [1.6, 0.8, 1] },
  { key: "sofa", label: "沙发", category: "家具", color: "#756d61", dimensions: [2, 0.9, 0.9] },
  { key: "tree", label: "树", category: "自然", color: "#47704b", dimensions: [1.4, 4.2, 1.4] },
  { key: "rock", label: "岩石", category: "自然", color: "#696b68", dimensions: [1.5, 1.2, 1.3] },
  { key: "boat", label: "船", category: "载具", color: "#725044", dimensions: [3, 1.2, 1.2] },
  { key: "car", label: "汽车", category: "载具", color: "#8a3d38", dimensions: [3.8, 1.4, 1.8] },
  { key: "cat", label: "猫", category: "动物", color: "#a88262", dimensions: [0.8, 0.55, 0.3] },
  { key: "horse", label: "马", category: "动物", color: "#654a3a", dimensions: [2.2, 1.8, 0.7] },
  { key: "wall", label: "墙体", category: "结构", color: "#aaa39a", dimensions: [3, 2.5, 0.25] },
];
