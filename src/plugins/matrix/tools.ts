import { tool } from "ai";
import { z } from "zod";
import type { MatrixInterface } from "../../interfaces/matrix.js";

let _matrixClient: MatrixInterface | null = null;

export function setMatrixClient(client: MatrixInterface | null) {
  _matrixClient = client;
}

export function getMatrixClient(): MatrixInterface | null {
  return _matrixClient;
}

export const matrixTool = tool({
  description:
    "Inspect and interact with Matrix: read room history, add emoji reactions, list joined rooms, create rooms, invite users, pin/manage iframe dashboard widgets, manage room state, or execute raw Matrix Client-Server REST API calls.",
  inputSchema: z.object({
    action: z
      .enum(["history", "react", "rooms", "createRoom", "invite", "widget", "state", "raw"])
      .describe(
        "history: read recent messages from a room. react: add an emoji reaction to a message event. rooms: list joined rooms. createRoom: create a new room/channel. invite: invite a user to a room. widget: add, update, or remove an embedded dashboard widget. state: get or set room state events. raw: make an arbitrary Matrix Client-Server API request.",
      ),
    roomId: z
      .string()
      .optional()
      .describe("Room ID (e.g. '!abc:matrix') for history, react, invite, widget, state, or raw"),
    limit: z
      .number()
      .optional()
      .describe("Maximum messages to return for 'history' (default 20, max 100)"),
    before: z
      .string()
      .optional()
      .describe("Pagination token (from/prev_batch) for 'history'"),
    eventId: z
      .string()
      .optional()
      .describe("Event ID (e.g. '$xyz...') for 'react'"),
    emoji: z
      .string()
      .optional()
      .describe("Emoji symbol for 'react' (e.g. '👍', '🚀', '👀')"),
    name: z
      .string()
      .optional()
      .describe("Room name for 'createRoom', or widget title for 'widget'"),
    topic: z
      .string()
      .optional()
      .describe("Room topic for 'createRoom'"),
    isDirect: z
      .boolean()
      .optional()
      .describe("Whether the room is a 1:1 direct chat for 'createRoom' (default false)"),
    userId: z
      .string()
      .optional()
      .describe("User ID (e.g. '@user:matrix') for 'invite'"),
    widgetUrl: z
      .string()
      .optional()
      .describe("URL for the embedded dashboard/widget for 'widget'"),
    widgetAction: z
      .enum(["set", "remove"])
      .optional()
      .describe("Action for 'widget' (default 'set')"),
    widgetId: z
      .string()
      .optional()
      .describe("Widget identifier for 'widget' (default 'widget_dashboard')"),
    eventType: z
      .string()
      .optional()
      .describe("State event type for 'state' (e.g. 'm.room.name', 'm.room.topic')"),
    stateKey: z
      .string()
      .optional()
      .describe("State key for 'state' (default '')"),
    method: z
      .enum(["GET", "POST", "PUT", "DELETE"])
      .optional()
      .describe("HTTP method for 'raw' or 'state' action (default GET)"),
    path: z
      .string()
      .optional()
      .describe("API path for 'raw' action (e.g. '/_matrix/client/v3/rooms/...')"),
    body: z
      .record(z.any())
      .optional()
      .describe("JSON payload object for 'createRoom', 'state', or 'raw' actions"),
  }),
  execute: async ({
    action,
    roomId,
    limit = 20,
    before,
    eventId,
    emoji,
    name,
    topic,
    isDirect,
    userId,
    widgetUrl,
    widgetAction = "set",
    widgetId = "widget_dashboard",
    eventType,
    stateKey = "",
    method = "GET",
    path,
    body,
  }) => {
    if (!_matrixClient) {
      return { error: "Matrix interface is not running or not configured on this agent." };
    }

    const client = _matrixClient;
    const boundedLimit = Math.min(Math.max(1, limit), 100);

    try {
      switch (action) {
        case "history": {
          if (!roomId) return { error: "roomId is required for 'history' action" };
          let query = `dir=b&limit=${boundedLimit}`;
          if (before) query += `&from=${encodeURIComponent(before)}`;
          const res = await client.callApi<any>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
          const chunk = res.chunk || [];
          const messages = chunk
            .filter((ev: any) => ev.type === "m.room.message")
            .map((ev: any) => ({
              eventId: ev.event_id,
              sender: ev.sender,
              originServerTs: ev.origin_server_ts ? new Date(ev.origin_server_ts).toISOString() : undefined,
              msgtype: ev.content?.msgtype,
              body: ev.content?.body,
            }));
          return {
            roomId,
            start: res.start,
            end: res.end,
            count: messages.length,
            messages,
          };
        }

        case "react": {
          if (!roomId) return { error: "roomId is required for 'react' action" };
          if (!eventId) return { error: "eventId is required for 'react' action" };
          if (!emoji) return { error: "emoji is required for 'react' action" };

          const txnId = `m_react_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const payload = {
            "m.relates_to": {
              rel_type: "m.annotation",
              event_id: eventId,
              key: emoji,
            },
          };
          const res = await client.callApi<any>(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
            payload,
          );
          return { success: true, eventId: res.event_id, reactionTo: eventId, emoji, roomId };
        }

        case "rooms": {
          const res = await client.callApi<any>("GET", "/_matrix/client/v3/joined_rooms");
          const joinedRooms: string[] = res.joined_rooms || [];
          const details = await Promise.all(
            joinedRooms.map(async (rId) => {
              let rName: string | undefined = undefined;
              let rTopic: string | undefined = undefined;
              try {
                const nameRes = await client.callApi<any>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(rId)}/state/m.room.name`);
                rName = nameRes.name;
              } catch {}
              try {
                const topicRes = await client.callApi<any>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(rId)}/state/m.room.topic`);
                rTopic = topicRes.topic;
              } catch {}
              return { roomId: rId, name: rName, topic: rTopic };
            }),
          );
          return { count: details.length, rooms: details };
        }

        case "createRoom": {
          const payload: Record<string, any> = {
            name,
            topic,
            is_direct: isDirect ?? false,
          };
          if (userId) {
            payload.invite = [userId];
          }
          if (body && typeof body === "object") {
            Object.assign(payload, body);
          }
          const res = await client.callApi<any>("POST", "/_matrix/client/v3/createRoom", payload);
          return { success: true, roomId: res.room_id, name, topic };
        }

        case "invite": {
          if (!roomId) return { error: "roomId is required for 'invite' action" };
          if (!userId) return { error: "userId is required for 'invite' action" };
          await client.callApi("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
            user_id: userId,
          });
          return { success: true, message: `Invited ${userId} to ${roomId}` };
        }

        case "widget": {
          if (!roomId) return { error: "roomId is required for 'widget' action" };

          if (widgetAction === "remove") {
            // Unpin widget
            try {
              const pinnedRes = await client.callApi<any>(
                "GET",
                `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets.pinned`,
              );
              const currentWidgets: string[] = pinnedRes.widgets || [];
              const filtered = currentWidgets.filter((id) => id !== widgetId);
              await client.callApi(
                "PUT",
                `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets.pinned`,
                { widgets: filtered },
              );
            } catch {}

            // Clear widget state event
            await client.callApi(
              "PUT",
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets/${encodeURIComponent(widgetId)}`,
              {},
            );
            return { success: true, message: `Removed widget ${widgetId} from ${roomId}` };
          }

          if (!widgetUrl) return { error: "widgetUrl is required when setting a widget" };

          const widgetTitle = name || "Dashboard";
          const widgetPayload = {
            type: "m.custom",
            url: widgetUrl,
            name: widgetTitle,
            creatorUserId: client.getUserId(),
            waitForIframeLoaded: true,
            data: {
              title: widgetTitle,
            },
          };

          // 1. Set widget event
          await client.callApi(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets/${encodeURIComponent(widgetId)}`,
            widgetPayload,
          );

          // 2. Pin widget to room
          let currentWidgets: string[] = [];
          try {
            const pinnedRes = await client.callApi<any>(
              "GET",
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets.pinned`,
            );
            if (Array.isArray(pinnedRes.widgets)) {
              currentWidgets = pinnedRes.widgets;
            }
          } catch {}

          if (!currentWidgets.includes(widgetId)) {
            currentWidgets.push(widgetId);
          }

          await client.callApi(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets.pinned`,
            { widgets: currentWidgets },
          );

          return {
            success: true,
            roomId,
            widgetId,
            name: widgetTitle,
            url: widgetUrl,
            message: `Widget '${widgetTitle}' pinned to room ${roomId}`,
          };
        }

        case "state": {
          if (!roomId) return { error: "roomId is required for 'state' action" };
          if (!eventType) return { error: "eventType is required for 'state' action" };

          const encRoom = encodeURIComponent(roomId);
          const encType = encodeURIComponent(eventType);
          const encKey = encodeURIComponent(stateKey);
          const statePath = stateKey
            ? `/_matrix/client/v3/rooms/${encRoom}/state/${encType}/${encKey}`
            : `/_matrix/client/v3/rooms/${encRoom}/state/${encType}`;

          if (method === "GET") {
            const res = await client.callApi<any>("GET", statePath);
            return { roomId, eventType, stateKey, content: res };
          } else {
            const res = await client.callApi<any>("PUT", statePath, body || {});
            return { success: true, eventId: res.event_id, roomId, eventType, stateKey };
          }
        }

        case "raw": {
          if (!path) return { error: "path is required for 'raw' action (e.g. '/_matrix/client/v3/...')" };
          const formattedPath = path.startsWith("/") ? path : `/${path}`;
          const res = await client.callApi<any>(method as any, formattedPath, body);
          return { result: res };
        }

        default:
          return { error: `Unknown action '${action}'` };
      }
    } catch (err: any) {
      return { error: `Matrix API error: ${err.message || String(err)}` };
    }
  },
});
