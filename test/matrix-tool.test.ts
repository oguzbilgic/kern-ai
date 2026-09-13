import test from "node:test";
import assert from "node:assert/strict";
import { matrixTool, setMatrixClient } from "../src/plugins/matrix/tools.ts";

test("matrixTool: returns error when client is not available", async () => {
  setMatrixClient(null);
  const result: any = await (matrixTool.execute as any)({
    action: "rooms",
  });
  assert.equal(result.error, "Matrix interface is not running or not configured on this agent.");
});

test("matrixTool: history action fetches and formats messages", async () => {
  const mockClient: any = {
    getUserId: () => "@vega:matrix",
    callApi: async (method: string, path: string) => {
      if (path.includes("/messages")) {
        return {
          start: "s1",
          end: "s2",
          chunk: [
            {
              event_id: "$ev1",
              type: "m.room.message",
              sender: "@oguz:matrix",
              origin_server_ts: 1710000000000,
              content: { msgtype: "m.text", body: "hello vega" },
            },
            {
              event_id: "$ev2",
              type: "m.room.member",
              sender: "@oguz:matrix",
            },
          ],
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  setMatrixClient(mockClient);
  const result: any = await (matrixTool.execute as any)({
    action: "history",
    roomId: "!room1:matrix",
    limit: 10,
  });

  assert.equal(result.roomId, "!room1:matrix");
  assert.equal(result.count, 1);
  assert.equal(result.messages[0].eventId, "$ev1");
  assert.equal(result.messages[0].body, "hello vega");
  setMatrixClient(null);
});

test("matrixTool: react action sends m.reaction annotation", async () => {
  let capturedPayload: any = null;
  const mockClient: any = {
    getUserId: () => "@vega:matrix",
    callApi: async (method: string, path: string, body: any) => {
      if (path.includes("/send/m.reaction/")) {
        capturedPayload = body;
        return { event_id: "$reaction_ev_1" };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  setMatrixClient(mockClient);
  const result: any = await (matrixTool.execute as any)({
    action: "react",
    roomId: "!room1:matrix",
    eventId: "$target_ev",
    emoji: "🚀",
  });

  assert.equal(result.success, true);
  assert.equal(result.emoji, "🚀");
  assert.deepEqual(capturedPayload, {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: "$target_ev",
      key: "🚀",
    },
  });
  setMatrixClient(null);
});

test("matrixTool: rooms action lists joined rooms with metadata", async () => {
  const mockClient: any = {
    getUserId: () => "@vega:matrix",
    callApi: async (method: string, path: string) => {
      if (path === "/_matrix/client/v3/joined_rooms") {
        return { joined_rooms: ["!r1:matrix", "!r2:matrix"] };
      }
      if (path.includes("/state/m.room.name")) {
        return { name: "Ops Room" };
      }
      if (path.includes("/state/m.room.topic")) {
        return { topic: "Coordination" };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  setMatrixClient(mockClient);
  const result: any = await (matrixTool.execute as any)({
    action: "rooms",
  });

  assert.equal(result.count, 2);
  assert.equal(result.rooms[0].roomId, "!r1:matrix");
  assert.equal(result.rooms[0].name, "Ops Room");
  assert.equal(result.rooms[0].topic, "Coordination");
  setMatrixClient(null);
});

test("matrixTool: widget action pins and removes widgets", async () => {
  const calls: { path: string; body: any }[] = [];
  const mockClient: any = {
    getUserId: () => "@vega:matrix",
    callApi: async (method: string, path: string, body: any) => {
      calls.push({ path, body });
      if (path.includes("widgets.pinned") && method === "GET") {
        return { widgets: [] };
      }
      return { event_id: "$widget_event" };
    },
  };

  setMatrixClient(mockClient);

  // 1. Set widget
  const setRes: any = await (matrixTool.execute as any)({
    action: "widget",
    roomId: "!r1:matrix",
    name: "Live Dashboard",
    widgetUrl: "https://botbin.io/7bnz86",
    widgetId: "widget_test",
  });

  assert.equal(setRes.success, true);
  assert.equal(setRes.widgetId, "widget_test");

  // Verify state events were called (widget definition + pinned array)
  assert.ok(calls.some((c) => c.path.includes("im.vector.modular.widgets/widget_test")));
  assert.ok(calls.some((c) => c.path.includes("im.vector.modular.widgets.pinned") && c.body?.widgets?.includes("widget_test")));

  // 2. Remove widget
  const removeRes: any = await (matrixTool.execute as any)({
    action: "widget",
    roomId: "!r1:matrix",
    widgetAction: "remove",
    widgetId: "widget_test",
  });

  assert.equal(removeRes.success, true);
  setMatrixClient(null);
});

test("matrixTool: raw action passes REST call through directly", async () => {
  let captured: any = null;
  const mockClient: any = {
    getUserId: () => "@vega:matrix",
    callApi: async (method: string, path: string, body: any) => {
      captured = { method, path, body };
      return { user_id: "@vega:matrix" };
    },
  };

  setMatrixClient(mockClient);
  const result: any = await (matrixTool.execute as any)({
    action: "raw",
    method: "GET",
    path: "/_matrix/client/v3/account/whoami",
  });

  assert.deepEqual(result, { result: { user_id: "@vega:matrix" } });
  assert.equal(captured.method, "GET");
  assert.equal(captured.path, "/_matrix/client/v3/account/whoami");
  setMatrixClient(null);
});
