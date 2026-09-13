import type { KernPlugin, PluginContext } from "../types.js";
import { matrixTool, setMatrixClient } from "./tools.js";
import { log } from "../../log.js";

export { setMatrixClient, getMatrixClient } from "./tools.js";

export const matrixPlugin: KernPlugin = {
  name: "matrix",

  tools: {
    matrix: matrixTool,
  },

  toolDescriptions: {
    matrix:
      "Inspect and interact with Matrix: read room history, add emoji reactions, list joined rooms, create rooms, invite users, pin/manage iframe dashboard widgets, manage room state, or execute raw Matrix Client-Server REST API calls.",
  },

  async onStartup(ctx: PluginContext) {
    // Client is set dynamically by MatrixInterface when started
    log("matrix", "matrix plugin registered");
  },

  async onShutdown() {
    setMatrixClient(null);
  },
};
