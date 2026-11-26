export type Location = {
  id: string;
  owner: string;
  relative: string;
  scope: "direct" | "retained" | "image";
  reason: string;
  measureTree?: true;
  platform?: "darwin" | "linux";
};
