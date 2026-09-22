import type { ModelMessage } from "ai";
import type { MemoryDB } from "../memory.js";
import type { KernConfig } from "../config.js";
import type { StreamEvent } from "../runtime.js";
import type { Attachment } from "../interfaces/types.js";

/**
 * Where a turn came from: the interface, the envelope channel label, the
 * platform conversation ID, and the user. Captured at the start of every
 * turn so async work spawned during it (background jobs, sub-agents) can
 * route its completion back to the same conversation.
 */
export interface TurnOrigin {
  /** Interface name (`telegram`, `slack`, `matrix`, `web`, ...). */
  interface: string;
  /** Human-readable channel label as it appears in the envelope. */
  channel: string;
  /** Platform conversation ID used to send replies. Absent for HTTP clients. */
  chatId?: string;
  /** Sender identifier. */
  userId: string;
}

/**
 * Plugin context — passed to all lifecycle hooks.
 * Provides access to shared infrastructure without coupling to runtime internals.
 */
export interface PluginContext {
  agentDir: string;
  config: KernConfig;
  db: MemoryDB;
  sessionId: () => string | null;
  /**
   * Origin of the turn currently being processed, or null when idle.
   * Turns are serialized, so this is safe to read from a tool's execute().
   */
  origin: () => TurnOrigin | null;
  /**
   * Deliver an async completion back to a conversation. Enqueues `text` as a
   * new turn stamped with the origin's envelope — the queue splices it into
   * the active turn if that conversation is still active, isolates it from
   * foreign turns otherwise, and wakes the agent when idle — then sends the
   * agent's reply to the origin chat. Resolves with the reply (`NO_REPLY`
   * when it was folded into an active turn).
   */
  announce: (text: string, origin: TurnOrigin) => Promise<string>;
}

/**
 * Route handler — raw HTTP request/response like server.ts uses.
 */
export interface RouteHandler {
  method: "GET" | "POST";
  path: string | RegExp;
  handler: (req: any, res: any, match?: RegExpMatchArray) => void | Promise<void>;
}

/**
 * Content to inject into the prompt before context assembly.
 */
export interface ContextInjection {
  /** XML tag name wrapping the content */
  label: string;
  /** The content to inject */
  content: string;
  /** Where to inject: "system" appends to system prompt, "user-prepend" prepends as user message */
  placement: "system" | "user-prepend";
  /** Optional SSE events to emit when this injection is applied */
  sseEvents?: StreamEvent[];
}

/**
 * Context passed to onBeforeContext hook.
 */
export interface BeforeContextInfo {
  /** Number of messages trimmed from start */
  trimmedCount: number;
  /** Token budget available for this injection */
  tokenBudget: number;
  /** Last user message text (for query-based injection like recall) */
  userQuery: string;
  /** Session ID */
  sessionId: string;
}

/**
 * KernPlugin — a self-contained feature module.
 *
 * Bundles tools, HTTP routes, SSE event types, and runtime lifecycle hooks.
 * Core server registers routes, runtime dispatches hooks, UI renders slots.
 */
export interface KernPlugin {
  name: string;

  /** Tools to register (merged into allTools) */
  tools?: Record<string, any>;

  /** HTTP routes to mount on the agent server */
  routes?: RouteHandler[];

  /** SSE event types this plugin emits */
  events?: string[];

  // --- Lifecycle hooks ---

  /** Called once on startup after DB is ready */
  onStartup?: (ctx: PluginContext) => Promise<void>;

  /** Called on graceful shutdown */
  onShutdown?: (ctx: PluginContext) => Promise<void>;

  /**
   * Called on each streaming step (tool-result).
   * Use to detect plugin-specific tool output and emit custom events.
   */
  onToolResult?: (
    toolName: string,
    result: string,
    emit: (event: StreamEvent) => void,
    ctx: PluginContext,
  ) => void;

  /**
   * Called after each completed turn. Use for async indexing work.
   */
  onTurnFinish?: (sessionId: string, ctx: PluginContext) => Promise<void>;

  /**
   * Called during context assembly to inject content into the system prompt.
   * Returns content to inject, or null to skip.
   */
  onBeforeContext?: (info: BeforeContextInfo, ctx: PluginContext) => Promise<ContextInjection | ContextInjection[] | null>;

  /**
   * Called when building /status response. Return key-value pairs to merge.
   */
  onStatus?: (ctx: PluginContext) => Record<string, any>;

  /**
   * Message lifecycle hooks — participate in message handling pipeline.
   */
  onMessage?: {
    /** Process user attachments. Return a ModelMessage if handled. */
    processAttachments?: (attachments: Attachment[], userMessage: string, ctx: PluginContext) => Promise<ModelMessage | null>;
    /** Resolve custom URIs in messages before model call. */
    resolveMessages?: (messages: ModelMessage[], ctx: PluginContext) => Promise<ModelMessage[]>;
  };

  /** Tool descriptions for system prompt injection (e.g. { recall: "search long-term memory..." }) */
  toolDescriptions?: Record<string, string>;

  /** Slash commands this plugin provides */
  commands?: Record<string, {
    description: string;
    handler: (ctx: PluginContext) => Promise<string>;
  }>;
}
