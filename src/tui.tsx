import React, { useState, useEffect } from "react";
import { render, Box, Text, Static, useInput, useApp, useStdout } from "ink";
// @ts-ignore
import Spinner from "ink-spinner";
import type { ServerEvent } from "./server.js";
import { isNoReply } from "./util.js";

// --- Types ---

interface ChatMessage {
  type: "user" | "assistant" | "incoming" | "outgoing" | "heartbeat" | "tool" | "error";
  text: string;
  meta?: string;
}

type RenderBlock =
  | { kind: "box"; msg: ChatMessage }
  | { kind: "assistant"; text: string }
  | { kind: "toolGroup"; tools: ChatMessage[] }
  | { kind: "error"; text: string };

interface TuiProps {
  port: number;
  agentName: string;
  agentDir: string;
  version: string;
  authToken?: string;
}

// --- Helpers ---

function wrapAndPadText(text: string, maxLen: number, iw: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  for (const line of lines) {
    if (line.length <= maxLen) {
      chunks.push(line);
    } else {
      const words = line.split(" ");
      let current = "";
      for (const word of words) {
        if (!current) {
          current = word;
        } else if (current.length + word.length + 1 <= maxLen) {
          current += " " + word;
        } else {
          chunks.push(current);
          current = word;
        }
      }
      if (current) chunks.push(current);
    }
  }
  return chunks.map(c => ("  " + c).padEnd(iw));
}

const TOOL_COLORS: Record<string, string> = {
  bash: "red", read: "cyan", write: "green", edit: "yellow",
  glob: "magenta", grep: "blue", webfetch: "cyan", kern: "white", message: "green",
};

function parseUserMessage(content: string): ChatMessage {
  const match = content.match(/^\[via ([^,]+),?\s*([^,]*),?\s*user:\s*([^,\]]*),?\s*(?:time:\s*([^\]]*))?\]\n?([\s\S]*)$/);
  if (match) {
    const [, iface, channel, userId, , text] = match;
    const cleanText = text.trim();
    if (iface.trim() === "tui") return { type: "user", text: cleanText || "(empty)" };
    if (iface.trim() === "system" && channel?.trim() === "heartbeat") return { type: "heartbeat", text: "" };
    return { type: "incoming", text: cleanText || "(empty)", meta: `[${iface.trim()} ${userId.trim()}]` };
  }
  if (content === "[heartbeat]") return { type: "heartbeat", text: "" };
  return { type: "user", text: content };
}

function convertHistory(history: any[]): ChatMessage[] {
  const raw: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user" && typeof m.content === "string") {
      raw.push(parseUserMessage(m.content));
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text" && p.text) {
            raw.push({ type: "assistant", text: p.text });
          } else if (p.type === "tool-call") {
            const input = p.input || {};
            const detail = input.path || input.command || input.pattern || input.url || input.action || input.userId || "";
            raw.push({ type: "tool", text: `${p.toolName} ${detail}` });
          }
        }
      } else if (typeof m.content === "string") {
        raw.push({ type: "assistant", text: m.content });
      }
    }
  }
  return raw;
}

function buildBlocks(messages: ChatMessage[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type === "user" || msg.type === "incoming" || msg.type === "outgoing" || msg.type === "heartbeat") {
      blocks.push({ kind: "box", msg });
      i++;
      continue;
    }
    if (msg.type === "tool") {
      const tools: ChatMessage[] = [];
      while (i < messages.length && messages[i].type === "tool") {
        tools.push(messages[i]);
        i++;
      }
      blocks.push({ kind: "toolGroup", tools });
      continue;
    }
    if (msg.type === "assistant") {
      blocks.push({ kind: "assistant", text: msg.text });
      i++;
      continue;
    }
    if (msg.type === "error") {
      blocks.push({ kind: "error", text: msg.text });
      i++;
      continue;
    }
    i++;
  }
  return blocks;
}

// --- Components ---

function InputBox({ input, busy, version, agentName, model, width, connected }: {
  input: string; busy: boolean; version: string; agentName: string; model: string; width: number; connected: boolean;
}) {
  const iw = width - 3;
  const cursor = "▎";
  const inputLine = ("  " + input + cursor).padEnd(iw);
  const connectionStr = connected ? "●" : "○";
  
  // Set border color based on connection status
  const borderColor = connected ? "green" : "red";
  return (
    <Box borderStyle="bold" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor={borderColor}>
      <Box flexDirection="column" width={iw}>
        <Text backgroundColor="#1a1a1a" color="white">{" ".repeat(iw)}</Text>
        <Text backgroundColor="#1a1a1a" color="white">{inputLine}</Text>
        <Text backgroundColor="#1a1a1a" color="white">{" ".repeat(iw)}</Text>
        <Text backgroundColor="#1a1a1a" dimColor italic>
          {"  kern v"}{version}{" · "}{agentName}{model ? " · " + model : ""}{" · "}
          <Text color={connected ? "green" : "red"}>{connectionStr}</Text>
          {" ".repeat(Math.max(0, iw - 13 - version.length - agentName.length - model.length - (model ? 3 : 0) - 2))}
        </Text>
        <Text backgroundColor="#1a1a1a" color="white">{" ".repeat(iw)}</Text>
      </Box>
    </Box>
  );
}

function MsgBox({ text, borderColor, width, label }: {
  text: string; borderColor: string; width: number; label?: string;
}) {
  const iw = width - 3;
  const maxLen = iw - 4; // 2 padding left + 2 padding right
  const lines = wrapAndPadText(text, maxLen, iw);
  const empty = " ".repeat(iw);

  return (
    <Box borderStyle="bold" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor={borderColor}>
      <Box flexDirection="column" width={iw}>
        <Text backgroundColor="#1a1a1a" color="white">{empty}</Text>
        {label && <Text backgroundColor="#1a1a1a" dimColor>{("  " + label).padEnd(iw)}</Text>}
        {lines.map((l, i) => (
          <Text key={i} backgroundColor="#1a1a1a" color="white">{l}</Text>
        ))}
        <Text backgroundColor="#1a1a1a" color="white">{empty}</Text>
      </Box>
    </Box>
  );
}

function MessageView({ msg, width }: { msg: ChatMessage; width: number }) {
  switch (msg.type) {
    case "user":
      return <MsgBox text={msg.text} borderColor="green" width={width} />;
    case "incoming":
      return <MsgBox text={msg.text} borderColor="yellow" width={width} label={msg.meta} />;
    case "outgoing":
      return <MsgBox text={msg.text} borderColor="green" width={width} label={msg.meta} />;
    case "heartbeat":
      return (
        <Box borderStyle="bold" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor="magenta" width={width}>
          <Box flexDirection="column" width={width - 3}>
            <Text backgroundColor="#1a1a1a" dimColor>{" ".repeat(width - 3)}</Text>
            <Text backgroundColor="#1a1a1a" color="magenta">{("  ♡ heartbeat").padEnd(width - 3)}</Text>
            <Text backgroundColor="#1a1a1a" dimColor>{" ".repeat(width - 3)}</Text>
          </Box>
        </Box>
      );
    case "assistant": {
      const isMuted = isNoReply(msg.text);
      return (
        <Box paddingLeft={3}>
          <Text color={isMuted ? undefined : "white"} dimColor={isMuted} italic={isMuted} wrap="wrap">
            {msg.text}
          </Text>
        </Box>
      );
    }
    case "error":
      return <Box paddingLeft={3}><Text color="red">{msg.text}</Text></Box>;
    default:
      return <Text>{msg.text}</Text>;
  }
}

function ToolGroupView({ tools }: { tools: ChatMessage[] }) {
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {tools.map((msg, i) => {
        const spaceIdx = msg.text.indexOf(" ");
        const toolName = spaceIdx > 0 ? msg.text.slice(0, spaceIdx) : msg.text;
        const toolDetail = spaceIdx > 0 ? msg.text.slice(spaceIdx) : "";
        const color = TOOL_COLORS[toolName] || "yellow";
        return (
          <Box key={i}>
            <Text color={color} bold={toolName === "kern"}>{toolName}</Text>
            <Text dimColor>{toolDetail}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function MarkdownText({ text, isMuted }: { text: string; isMuted?: boolean }) {
  if (isMuted) {
    return (
      <Text color={undefined} dimColor italic wrap="wrap">
        {text}
      </Text>
    );
  }

  const blocks: { type: string; content: string }[] = [];
  const codeSplit = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < codeSplit.length; i++) {
    const part = codeSplit[i];
    if (i % 2 === 1) {
      let code = part.slice(3, -3);
      const firstNewline = code.indexOf("\n");
      if (firstNewline !== -1 && !code.slice(0, firstNewline).includes(" ")) {
        code = code.slice(firstNewline + 1);
      } else if (code.startsWith("\n")) {
        code = code.slice(1);
      }
      if (code.endsWith("\n")) code = code.slice(0, -1);
      blocks.push({ type: "code", content: code });
    } else if (part) {
      let textPart = part;
      if (i > 0 && textPart.startsWith("\n")) textPart = textPart.slice(1);
      if (i < codeSplit.length - 1 && textPart.endsWith("\n")) textPart = textPart.slice(0, -1);
      if (!textPart) continue;

      const lines = textPart.split("\n");
      let currentType = "text";
      let currentContent: string[] = [];
      
      const flush = () => {
        if (currentContent.length > 0) {
          blocks.push({ type: currentType, content: currentContent.join("\n") });
          currentContent = [];
        }
      };

      for (const line of lines) {
        if (line.match(/^#{1,6}\s+/)) {
          flush();
          blocks.push({ type: "heading", content: line });
        } else if (line.startsWith(">")) {
          if (currentType !== "quote") flush();
          currentType = "quote";
          let quoteContent = line.slice(1);
          if (quoteContent.startsWith(" ")) quoteContent = quoteContent.slice(1);
          currentContent.push(quoteContent);
        } else {
          if (currentType === "quote" && line.trim() === "") {
             flush();
             currentType = "text";
             currentContent.push(line);
          } else if (currentType === "quote") {
             let quoteContent = line.startsWith(">") ? line.slice(1) : line;
             if (quoteContent.startsWith(" ")) quoteContent = quoteContent.slice(1);
             currentContent.push(quoteContent);
          } else {
             currentType = "text";
             currentContent.push(line);
          }
        }
      }
      flush();
    }
  }

  const renderInline = (str: string) => {
    const inlineParts = str.split(/(\*\*[\s\S]+?\*\*|\*[^*]+\*|`[^`]+`)/g);
    return inlineParts.map((p, i) => {
      if (!p) return null;
      if (p.startsWith("**") && p.endsWith("**")) {
        return <Text key={i} bold color="white">{p.slice(2, -2)}</Text>;
      }
      if (p.startsWith("*") && p.endsWith("*")) {
        return <Text key={i} italic color="white">{p.slice(1, -1)}</Text>;
      }
      if (p.startsWith("`") && p.endsWith("`")) {
        return <Text key={i} color="cyan">{p.slice(1, -1)}</Text>;
      }
      return <Text key={i} color="white">{p}</Text>;
    });
  };

  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <Box key={i} borderStyle="bold" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="#555">
              <Box flexDirection="column" paddingLeft={1}>
                {b.content.split("\n").map((l, j) => (
                  <Text key={j} color="#ccc">{l}</Text>
                ))}
              </Box>
            </Box>
          );
        }
        if (b.type === "heading") {
          return (
            <Box key={i} marginTop={i === 0 ? 0 : 1} marginBottom={0}>
              <Text bold color="yellow">{renderInline(b.content)}</Text>
            </Box>
          );
        }
        if (b.type === "quote") {
          return (
            <Box key={i} borderStyle="bold" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="#888">
              <Box flexDirection="column" paddingLeft={1}>
                <Text wrap="wrap" color="#ccc" italic>{renderInline(b.content)}</Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text wrap="wrap">{renderInline(b.content)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function RenderBlockView({ block, width }: { block: RenderBlock; width: number }) {
  switch (block.kind) {
    case "box":
      return <MessageView msg={block.msg} width={width} />;
    case "toolGroup":
      return <ToolGroupView tools={block.tools} />;
    case "assistant": {
      const isMuted = isNoReply(block.text);
      return (
        <Box paddingLeft={3}>
          <MarkdownText text={block.text} isMuted={isMuted} />
        </Box>
      );
    }
    case "error":
      return <Box paddingLeft={3}><Text color="red">{block.text}</Text></Box>;
  }
}

// --- App ---

function App({ port, agentName, agentDir, version, authToken }: TuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const authHeaders: Record<string, string> = authToken ? { "Authorization": `Bearer ${authToken}` } : {};
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [model, setModel] = useState("");
  const [connected, setConnected] = useState(false);
  const [currentPort, setCurrentPort] = useState(port);
  const baseUrl = `http://127.0.0.1:${currentPort}`;
  const [cols, setCols] = useState(stdout?.columns || 80);

  useEffect(() => {
    if (!stdout) return;
    const handleResize = () => {
      setCols(stdout.columns);
      // Optional: force a clear of the current active render area to avoid artifacts
      // but Ink might handle this if cols state updates
    };
    stdout.on("resize", handleResize);
    return () => { stdout.off("resize", handleResize); };
  }, [stdout]);

  // Load history + status
  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch(`${baseUrl}/status`, { headers: authHeaders })).json();
        if (s.model) setModel(s.model);
      } catch {}
      try {
        const h = await (await fetch(`${baseUrl}/history?limit=30`, { headers: authHeaders })).json();
        if (h.length > 0) {
          setMessages(convertHistory(h));
        }
      } catch {}
    })();
  }, []);

  // SSE
  useEffect(() => {
    let aborted = false;
    const baseUrl = `http://127.0.0.1:${currentPort}`;
    
    function handle(event: ServerEvent) {
      if ((event as any).type === "incoming" && event.fromInterface !== "tui") {
        const iface = event.fromInterface || "unknown";
        const user = event.fromUserId || "";
        const label = (user && user !== iface) ? `[${iface} ${user}]` : `[${iface}]`;
        setMessages((m: ChatMessage[]) => [...m, {
          type: "incoming", text: event.text || "",
          meta: label,
        }]);
        return;
      }
      if ((event as any).type === "outgoing") {
        setMessages((m: ChatMessage[]) => [...m, {
          type: "outgoing", text: event.text || "",
          meta: `[→ ${event.fromInterface} ${event.fromUserId || ""}]`,
        }]);
        return;
      }
      if ((event as any).type === "heartbeat") {
        setMessages((m: ChatMessage[]) => [...m, { type: "heartbeat", text: "" }]);
        return;
      }
      if ((event as any).type === "command-result") {
        setMessages((m: ChatMessage[]) => [...m, { type: "assistant", text: event.text || "" }]);
        return;
      }
      switch (event.type) {
        case "thinking":
          setBusy(true);
          break;
        case "text-delta":
          setStreamingText((s: string) => s + (event.text || ""));
          setBusy(true);
          break;
        case "tool-call": {
          const detail = event.toolDetail ? ` ${event.toolDetail}` : "";
          setStreamingText((s: string) => {
            if (s) {
              setMessages((m: ChatMessage[]) => [
                ...m,
                { type: "assistant", text: s },
                { type: "tool", text: `${event.toolName}${detail}` }
              ]);
            } else {
              setMessages((m: ChatMessage[]) => [...m, { type: "tool", text: `${event.toolName}${detail}` }]);
            }
            return "";
          });
          setBusy(true);
          break;
        }
        case "finish":
          setStreamingText((s: string) => {
            if (s) {
              setMessages((m: ChatMessage[]) => [...m, { type: "assistant", text: s }]);
            }
            return "";
          });
          setBusy(false);
          break;
        case "error":
          setMessages((m: ChatMessage[]) => [...m, { type: "error", text: event.error || "Unknown error" }]);
          setStreamingText("");
          setBusy(false);
          break;
      }
    }
    async function connect() {
      try {
        const res = await fetch(`${baseUrl}/events`, { headers: authHeaders });
        setConnected(true);

        // Refetch status to update model on reconnect
        fetch(`${baseUrl}/status`, { headers: authHeaders })
          .then((r) => r.json())
          .then((s) => {
            if (s.model) setModel(s.model);
          })
          .catch(() => {});

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try { handle(JSON.parse(line.slice(6))); } catch {}
          }
        }
        if (!aborted) {
          setConnected(false);
          // After a restart the agent may have moved ports: re-read <agentDir>/.kern/
          import("./agent-dir.js").then(({ readAgentInfo, isProcessRunning }) => {
            const agent = readAgentInfo(agentDir);
            if (agent?.port && agent.port !== currentPort && agent.pid && isProcessRunning(agent.pid)) {
              setCurrentPort(agent.port);
            } else {
              setTimeout(connect, 2000);
            }
          }).catch(() => setTimeout(connect, 2000));
        }
      } catch {
        if (!aborted) {
          setConnected(false);
          // After a restart the agent may have moved ports: re-read <agentDir>/.kern/
          import("./agent-dir.js").then(({ readAgentInfo, isProcessRunning }) => {
            const agent = readAgentInfo(agentDir);
            if (agent?.port && agent.port !== currentPort && agent.pid && isProcessRunning(agent.pid)) {
              setCurrentPort(agent.port);
            } else {
              setTimeout(connect, 2000);
            }
          }).catch(() => setTimeout(connect, 2000));
        }
      }
    }
    connect();
    return () => { aborted = true; };
  }, [currentPort, agentName]);

  // Input
  useInput((ch: string, key: any) => {
    if (key.escape) { exit(); return; }

    if (key.return && input.trim()) {
      const text = input.trim();
      setInput("");
      setMessages((m: ChatMessage[]) => [...m, { type: "user", text }]);
      if (!busy) setBusy(true);
      fetch(`${baseUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ text, userId: "tui", interface: "tui", channel: "tui" }),
      }).catch(() => {
        setMessages((m: ChatMessage[]) => [...m, { type: "error", text: "Connection error" }]);
        if (!busy) setBusy(false);
      });
      return;
    }
    if (key.backspace || key.delete) { 
      setInput((s: string) => s.slice(0, -1));
      return; 
    }
    if (ch && !key.ctrl && !key.meta) { 
      setInput((s: string) => s + ch);
    }
  });

  return (
    <Box flexDirection="column">
      {(() => {
        const blocks = buildBlocks(messages);
        return (
          <Static items={blocks.map((block, i) => ({ id: String(i), block }))}>
            {({ id, block }: { id: string; block: RenderBlock }) => (
              <Box key={id} marginTop={1}>
                <RenderBlockView block={block} width={cols} />
              </Box>
            )}
          </Static>
        );
      })()}

      <Box flexDirection="column">
        {streamingText && (
          <Box marginTop={1} paddingLeft={3}>
            {(() => {
              const isMuted = isNoReply(streamingText);
              return <MarkdownText text={streamingText} isMuted={isMuted} />;
            })()}
          </Box>
        )}
        {busy && !streamingText && (
          <Box marginTop={1} paddingLeft={3}>
            {/* @ts-ignore */}
            <Text color="blue"><Spinner type="dots" /></Text>
            <Text dimColor> thinking...</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Box flexDirection="column">
            <InputBox input={input} busy={busy} version={version} agentName={agentName} model={model} width={cols} connected={connected} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// --- Entry ---

export async function connectTui(port: number, agentName: string, agentDir: string, authToken?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  let model = "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { headers });
    if (res.status === 401) {
      console.error(`Auth required for ${agentName}. Check KERN_AUTH_TOKEN in .kern/.env`);
      process.exit(1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    model = status.model || "";
  } catch (e: any) {
    if (e.message?.includes("Auth required")) throw e;
    console.error(`Cannot connect to ${agentName} on port ${port}`);
    process.exit(1);
  }

  let version = "?";
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf-8"));
    version = pkg.version;
  } catch {}

  const { waitUntilExit } = render(
    <App port={port} agentName={agentName} agentDir={agentDir} version={version} authToken={authToken} />,
    { exitOnCtrlC: true }
  );
  await waitUntilExit();

  process.stdout.write("\x1b[2J\x1b[H");
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  process.stdout.write(`\n  ${bold("kern")} ${dim("v" + version)} · ${agentName}${model ? " · " + model : ""} · ${dim("running")}\n\n`);
  process.exit(0);
}
