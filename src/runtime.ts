import { streamText, type ModelMessage, stepCountIs } from "ai";
import { log } from "./log.js";
import { createModel } from "./model.js";
import { allTools, type ToolName } from "./tools/index.js";
import { SessionManager } from "./session.js";
import { estimateTextTokens } from "./context.js";
import { loadConfig, getToolsForScope, type KernConfig } from "./config.js";
import { initKernTool, incrementMessageCount, addTokenUsage } from "./tools/kern.js";
import type { SegmentIndex } from "./segments.js";
import type { MemoryDB } from "./memory.js";
import { prepareContext, loadSystemPrompt, buildSystemMessage, addCacheBreakpoints, type PrepareContextOptions } from "./context.js";
import type { ContextInjection, BeforeContextInfo } from "./plugins/types.js";
import type { Attachment } from "./interfaces/types.js";
import { extractText } from "./util.js";
export type { SessionStats } from "./context.js";



export interface StreamEvent {
  type: string;
  text?: string;
  toolName?: string;
  toolDetail?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  [key: string]: unknown;
}

export type StreamHandler = (event: StreamEvent) => void;

export class Runtime {
  private config!: KernConfig;
  private systemPrompt!: string;
  private session!: SessionManager;
  private agentDir: string;
  private segmentIndex: SegmentIndex | null = null;
  private memoryDB: MemoryDB | null = null;

  /** Plugin hook — called on each tool result for custom event emission */
  onToolResult: ((toolName: string, result: string, emit: (event: StreamEvent) => void) => void) | null = null;

  /** Plugin hook — collect context injections before each turn */
  private contextInjectionFn: ((info: BeforeContextInfo) => Promise<ContextInjection[]>) | null = null;

  /** Plugin hook — process user attachments into a ModelMessage */
  onProcessAttachments: ((attachments: Attachment[], userMessage: string) => Promise<ModelMessage | null>) | null = null;

  /** Plugin hook — resolve custom URIs in messages before model call */
  onResolveMessages: ((messages: ModelMessage[]) => Promise<ModelMessage[]>) | null = null;

  /** Additional tools registered by plugins */
  private pluginTools: Record<string, any> = {};

  /** Tool descriptions from plugins for system prompt */
  private pluginToolDescriptions: Record<string, string> = {};

  constructor(agentDir: string) {
    this.agentDir = agentDir;
  }

  addTools(tools: Record<string, any>) {
    Object.assign(this.pluginTools, tools);
  }

  setPluginToolDescriptions(descriptions: Record<string, string>) {
    this.pluginToolDescriptions = descriptions;
  }

  setContextInjectionFn(fn: (info: BeforeContextInfo) => Promise<ContextInjection[]>) {
    this.contextInjectionFn = fn;
  }

  setSegmentIndex(index: SegmentIndex) {
    this.segmentIndex = index;
  }

  setMemoryDB(db: MemoryDB) {
    this.memoryDB = db;
  }

  async setPairingManager(pairing: any): Promise<void> {
    const { initKernTool } = await import("./tools/kern.js");
    await initKernTool({
      agentDir: this.agentDir,
      config: this.config,
      sessionId: this.session.getSessionId() || "unknown",
      getSessionStats: () => {
        const prepared = prepareContext({ messages: this.session.getMessages(), config: this.config, sessionId: this.session.getSessionId() || undefined, segmentIndex: this.segmentIndex });
        const summaryChars = prepared.systemAdditions.join("\n\n").length;
        prepared.stats.systemPromptTokens = estimateTextTokens(this.systemPrompt) + (summaryChars > 0 ? estimateTextTokens("\n\n") : 0);
        return prepared.stats;
      },
      pairingManager: pairing,
    });
  }

  async init(): Promise<void> {
    this.config = await loadConfig(this.agentDir);
    this.systemPrompt = await loadSystemPrompt(this.agentDir, this.config, this.pluginToolDescriptions);
    this.session = new SessionManager(this.agentDir);
    await this.session.init();
    await this.session.load();

    await initKernTool({
      agentDir: this.agentDir,
      config: this.config,
      sessionId: this.session.getSessionId() || "unknown",
      getSessionStats: () => {
        const prepared = prepareContext({ messages: this.session.getMessages(), config: this.config, sessionId: this.session.getSessionId() || undefined, segmentIndex: this.segmentIndex });
        const summaryChars = prepared.systemAdditions.join("\n\n").length;
        prepared.stats.systemPromptTokens = estimateTextTokens(this.systemPrompt) + (summaryChars > 0 ? estimateTextTokens("\n\n") : 0);
        return prepared.stats;
      },
    });
  }

  // Pending messages to inject via prepareStep
  private pendingInjections: (() => { role: string; content: string }[]) | null = null;

  setPendingInjections(fn: () => { role: string; content: string }[]) {
    this.pendingInjections = fn;
  }

  async buildPromptContext(options?: Partial<PrepareContextOptions> & {
    userQuery?: string;
    onEvent?: StreamHandler;
  }) {
    const allMessages = options?.messages ?? this.session.getMessages();
    const sessionId = options?.sessionId ?? (this.session.getSessionId() || undefined);
    const prepared = prepareContext({
      messages: allMessages,
      config: options?.config ?? this.config,
      sessionId,
      segmentIndex: options?.segmentIndex ?? this.segmentIndex,
    });
    const effectiveSystemPrompt = prepared.systemAdditions.length > 0
      ? `${this.systemPrompt}\n\n${prepared.systemAdditions.join("\n\n")}`
      : this.systemPrompt;
    // Estimate system prompt tokens (minus summary which is tracked separately)
    const summaryAdditionChars = prepared.systemAdditions.join("\n\n").length;
    prepared.stats.systemPromptTokens = estimateTextTokens(effectiveSystemPrompt) - (summaryAdditionChars > 0 ? Math.ceil(summaryAdditionChars / 3.3) : 0);

    // Apply plugin context injections (notes, skills, recall, etc.)
    let systemWithInjections: string = effectiveSystemPrompt;
    let contextMessages = prepared.messages;
    const trimmedCount = prepared.stats.totalMessages - prepared.stats.windowMessages + (prepared.stats.summaryTokens > 0 ? 1 : 0);

    if (this.contextInjectionFn) {
      try {
        const injections = await this.contextInjectionFn({
          trimmedCount,
          tokenBudget: 2000,
          userQuery: options?.userQuery ?? "",
          sessionId: sessionId || "",
        });
        for (const inj of injections) {
          if (inj.placement === "user-prepend") {
            const msg: ModelMessage = {
              role: "user",
              content: `<${inj.label}>\n${inj.content}\n</${inj.label}>`,
            };
            contextMessages = [msg, ...contextMessages];
          } else {
            // "system" — append to system prompt, wrapped in label tag for context UI
            const injection = inj.label
              ? `<${inj.label}>\n${inj.content}\n</${inj.label}>`
              : inj.content;
            systemWithInjections = `${systemWithInjections}\n\n${injection}`;
          }
          // Emit any SSE events the plugin attached
          if (inj.sseEvents && options?.onEvent) {
            for (const ev of inj.sseEvents) {
              options.onEvent(ev);
            }
          }
        }
      } catch (err: any) {
        log.error("context", `plugin context injection failed: ${err.message}`);
      }
    }

    const system = buildSystemMessage(systemWithInjections, this.config);
    const messages = addCacheBreakpoints(contextMessages, this.config);

    return {
      system,
      messages,
      stats: prepared.stats,
    };
  }

  async handleMessage(
    userMessage: string,
    onEvent: StreamHandler,
    attachments?: Attachment[],
    abortSignal?: AbortSignal,
  ): Promise<string> {
    // Signal that we're processing
    onEvent({ type: "thinking" });

    // Reload system prompt (picks up new daily notes, summaries, knowledge changes)
    this.systemPrompt = await loadSystemPrompt(this.agentDir, this.config, this.pluginToolDescriptions);

    // Add user message to session
    const preview = userMessage.slice(0, 80).replace(/\n/g, " ");
    log("runtime", `handleMessage: ${preview}${userMessage.length > 80 ? "..." : ""}${attachments?.length ? ` +${attachments.length} attachment(s)` : ""}`);

    // Process attachments via plugin, or build plain text message
    let userMsg: ModelMessage;
    if (attachments && attachments.length > 0 && this.onProcessAttachments) {
      const pluginMsg = await this.onProcessAttachments(attachments, userMessage);
      userMsg = pluginMsg ?? { role: "user", content: userMessage };
    } else {
      userMsg = { role: "user", content: userMessage };
    }
    await this.session.append([userMsg]);
    incrementMessageCount();

    // Build tools from scope + plugins
    const tools: Record<string, any> = {};
    for (const name of getToolsForScope(this.config.toolScope)) {
      if (name in allTools) {
        tools[name] = allTools[name as ToolName];
      }
    }
    // Plugin tools are always included (not gated by scope)
    Object.assign(tools, this.pluginTools);

    const model = createModel(this.config);
    let streamError: any = null;

    try {
      let fullText = "";

      const allMessages = this.session.getMessages();
      const sessionId = this.session.getSessionId() || undefined;
      const { system: systemWithInjections, messages: contextMessages, stats } = await this.buildPromptContext({
        messages: allMessages,
        sessionId,
        userQuery: userMessage,
        onEvent,
      });
      const trimmedCount = stats.totalMessages - stats.windowMessages + (stats.summaryTokens > 0 ? 1 : 0);
      if (trimmedCount > 0) {
        log("context", `trimmed: ${trimmedCount} old messages excluded${stats.summaryTokens > 0 ? `, summary injected (~${stats.summaryTokens} tokens)` : ''}`);
      }

      // Resolve custom URIs in messages via plugins (e.g. kern-media://)
      const resolvedMessages = this.onResolveMessages
        ? await this.onResolveMessages(contextMessages)
        : contextMessages;

      log.debug("context", `${resolvedMessages.length} messages, ~${stats.windowTokens} tokens`);
      if (resolvedMessages.length > 0) {
        const first = resolvedMessages[0];
        const last = resolvedMessages[resolvedMessages.length - 1];
        log.debug("context", `first msg: role=${first.role}, last msg: role=${last.role}`);
      }

      const pendingInjections = this.pendingInjections;
      let persistedCount = 0;
      // Accumulate mid-turn injections so they persist across all subsequent steps.
      // Each injection records the chronological position (insertAt) where it arrived,
      // so we can splice it back into that position on later steps instead of pinning
      // it to the end — otherwise the model keeps treating it as the freshest message.
      const midTurnMessages: { insertAt: number; msg: { role: "user"; content: string } }[] = [];

      // For Ollama: pass num_ctx to limit KV cache allocation, disable thinking for speed
      const ollamaOptions = this.config.provider === "ollama"
        ? { providerOptions: { openai: { num_ctx: this.config.maxContextTokens, think: false } } }
        : {};

      const result = streamText({
        model,
        system: systemWithInjections,
        messages: resolvedMessages,
        tools,
        abortSignal,
        ...ollamaOptions,
        stopWhen: stepCountIs(this.config.maxSteps),
        onError: ({ error }) => {
          streamError = error;
        },
        onStepFinish: async (step) => {
          // Persist only new messages from this step (response.messages is cumulative)
          const allMsgs = step.response.messages as ModelMessage[];
          const newMsgs = allMsgs.slice(persistedCount).map((msg) => {
            if (msg.role === "assistant" && typeof msg.content === "string") {
              return { ...msg, content: msg.content.replace(/^\n+/, "") };
            }
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
              return { ...msg, content: msg.content.map((part: any) =>
                part.type === "text" ? { ...part, text: part.text.replace(/^\n+/, "") } : part
              )};
            }
            return msg;
          });
          if (newMsgs.length > 0) {
            await this.session.append(newMsgs);
            persistedCount = allMsgs.length;
            log("runtime", `step ${step.stepNumber} persisted ${newMsgs.length} new message(s)`);
          }
        },
        prepareStep: ({ messages, stepNumber }) => {
          // Final-step tool lockout (#310): when the next step is the last one
          // allowed by maxSteps, disable tools and tell the model to wrap up.
          // Without this, a turn that hits the cap ends on a tool result with
          // no final text — the user gets silence and the session ends without
          // a conclusion. Forcing the last step to be text-only guarantees
          // every capped turn closes with an assistant message.
          const finalStep = stepNumber >= this.config.maxSteps - 1
            ? {
                toolChoice: "none" as const,
                system: systemWithInjections +
                  "\n\n[System: step limit reached — this is the final step of this turn. " +
                  "Tools are disabled. Summarize what you accomplished, what remains, and reply to the user now.]",
              }
            : {};
          if (stepNumber >= this.config.maxSteps - 1) {
            log("runtime", `prepareStep: step limit reached at step ${stepNumber} — forcing text-only final step`);
          }

          if (stepNumber === 0 || !pendingInjections) return finalStep;

          // Collect any new injections; record the chronological position
          // (current messages length) at which each arrived.
          const injections = pendingInjections();
          for (const msg of injections) {
            const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
            midTurnMessages.push({
              insertAt: messages.length,
              msg: { role: "user" as const, content: text },
            });
            // Persist to session JSONL so the next turn sees it in proper order.
            // prepareStep is synchronous — handle the Promise explicitly so a
            // failed write logs instead of surfacing as an unhandled rejection.
            void this.session.append([{ role: "user", content: msg.content }]).catch((err) => {
              log("runtime", `prepareStep: failed to persist mid-turn message: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          if (midTurnMessages.length === 0) return finalStep;

          log("runtime", `prepareStep: splicing ${midTurnMessages.length} mid-turn message(s) at step ${stepNumber}`);

          // Splice each injection at its recorded position. Process in reverse
          // order of insertAt so earlier indices don't shift when we insert later ones.
          // When multiple injections share the same insertAt (arrived in the same
          // step), process later arrivals first so repeated splices at the same
          // index preserve original arrival order in the final array.
          const out = [...messages];
          const sorted = midTurnMessages
            .map((entry, index) => ({ entry, index }))
            .sort((a, b) => {
              const byInsertAt = b.entry.insertAt - a.entry.insertAt;
              return byInsertAt !== 0 ? byInsertAt : b.index - a.index;
            });
          for (const { entry: { insertAt, msg } } of sorted) {
            out.splice(insertAt, 0, msg);
          }

          return { ...finalStep, messages: out };
        },
      });

      let textStarted = false;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          let text = ("delta" in part ? part.delta : (part as any).text) || "";
          if (!textStarted) {
            text = text.replace(/^\n+/, "");
            if (!text) continue;
            textStarted = true;
          }
          fullText += text;
          onEvent({ type: "text-delta", text });
        } else if (part.type === "tool-call") {
          const args = ("args" in part ? part.args : part.input) as Record<string, unknown>;
          let detail = String(args.path || args.command || args.pattern || args.url || args.action || args.userId || args.query || args.file || "");
          // Enrich detail for tools with extra display-worthy params
          if (args.pages) detail += ` pages:${args.pages}`;
          if (args.prompt && (part.toolName === "pdf" || part.toolName === "image")) detail += ` "${String(args.prompt).slice(0, 60)}"`;
          if (args.offset) detail += ` +${args.offset}`;
          if (args.limit && args.limit !== 2000) detail += ` limit:${args.limit}`;
          onEvent({ type: "tool-call", toolName: part.toolName, toolDetail: detail, toolInput: args });
        } else if (part.type === "tool-result") {
          const output = (part as any).output;
          const resultText = typeof output === "string" ? output : JSON.stringify(output);
          onEvent({ type: "tool-result", toolName: part.toolName, toolResult: resultText });

          // Dispatch to plugins for custom event emission
          if (this.onToolResult) {
            this.onToolResult(part.toolName, resultText, onEvent);
          }
        }
      }

      log("runtime", `stream finished, text length: ${fullText.length}`);

      // If the stream had an error and produced no output, throw to hit error handler
      if (streamError && fullText.length === 0) {
        throw streamError;
      }

      try {
        const usage = await result.totalUsage;
        const cacheRead = usage.inputTokenDetails?.cacheReadTokens || 0;
        const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens || 0;
        const inputTotal = usage.inputTokens || 0;
        addTokenUsage(inputTotal, usage.outputTokens || 0, cacheRead, cacheWrite);
        if (cacheRead || cacheWrite) {
          const pct = inputTotal > 0 ? Math.round(cacheRead / inputTotal * 100) : 0;
          log("runtime", `cache: ${cacheRead} read, ${cacheWrite} written (${pct}% hit rate, ${inputTotal} total input)`);
        }
      } catch {
        // usage tracking failed — non-critical
      }

      onEvent({ type: "finish", text: fullText });

      return fullText || "(no text response)";
    } catch (error: any) {
      // Aborted by the queue's idle timeout — the queue already rejected the
      // turn and reported the timeout. Steps completed before the abort were
      // persisted by onStepFinish; exit quietly instead of double-reporting.
      if (abortSignal?.aborted) {
        const { message: msg, category } = parseProviderError(streamError, error);
        log("runtime", `turn aborted (idle timeout) — stream stopped [${category}: ${msg}]`);
        throw error;
      }
      const { message: msg, category } = parseProviderError(streamError, error);
      log.error("runtime", `[${category}] ${msg}`);
      onEvent({ type: "error", error: msg });
      throw new Error(msg);
    }
  }


  getSessionId(): string | null {
    return this.session.getSessionId();
  }

  async getSystemPrompt(): Promise<string> {
    this.systemPrompt = await loadSystemPrompt(this.agentDir, this.config, this.pluginToolDescriptions);
    const { system } = await this.buildPromptContext();
    return typeof system === "string" ? system : system.content;
  }

  getMessages(): ModelMessage[] {
    return this.session.getMessages();
  }
}

/** Clean error categorization from provider error chains */
function parseProviderError(
  streamError: unknown,
  caughtError: any
): { message: string; category: string } {
  const realError: any = streamError || caughtError;
  const lastErr = realError?.lastError || realError;
  const cause: any = lastErr?.cause || realError?.cause;
  const status = lastErr?.statusCode || lastErr?.data?.error?.code;
  const rawApiMsg = lastErr?.data?.error?.message || lastErr?.responseBody;

  // Detect HTML error pages
  const isHtml = (s: unknown): boolean =>
    typeof s === "string" && s.includes("<html");

  const apiMsg = isHtml(rawApiMsg)
    ? null // discard HTML, fall through to status-based matching
    : rawApiMsg;

  // Priority-ordered matchers: first match wins
  const matchers: Array<{
    test: () => boolean;
    category: string;
    message: string;
  }> = [
    {
      test: () => cause?.code === "EAI_AGAIN" || cause?.code === "ENOTFOUND",
      category: "network",
      message: "DNS resolution failed — check network connection",
    },
    {
      test: () => status === 401 || status === 403,
      category: "auth",
      message: "API authentication failed — check your API key in .kern/.env",
    },
    {
      test: () => status === 429 || apiMsg?.includes?.("rate limit"),
      category: "rate_limit",
      message: "Rate limit hit — wait a moment and try again",
    },
    {
      test: () =>
        status === 402 ||
        apiMsg?.includes?.("credit") ||
        apiMsg?.includes?.("insufficient"),
      category: "billing",
      message:
        "API credits exhausted — check your OpenRouter/provider balance",
    },
    {
      test: () => status === 502 || isHtml(rawApiMsg),
      category: "provider",
      message:
        "Provider returned 502 Bad Gateway — the upstream model may be temporarily unavailable",
    },
    {
      test: () => !!apiMsg,
      category: "provider",
      message: apiMsg,
    },
    {
      test: () =>
        !!lastErr?.message &&
        !lastErr.message.includes("No output generated") &&
        !isHtml(lastErr.message),
      category: "provider",
      message: lastErr?.message,
    },
    {
      test: () => caughtError?.message?.includes?.("No output generated"),
      category: "no_output",
      message: `No response from model (${cause?.message || cause || lastErr?.message || "unknown cause"})`,
    },
  ];

  for (const m of matchers) {
    if (m.test()) return { message: m.message, category: m.category };
  }

  return {
    message: caughtError?.message || "Unknown error",
    category: "unknown",
  };
}
