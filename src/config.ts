import { createMeshConfig } from "@baditaflorin/mesh-common";

export const config = createMeshConfig({
  appName: "mesh-qr-snake",
  description: "Daisy-chain QR around a circle of phones — payload walks zero-network",
  accentHex: "#22a6b3",
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
});
