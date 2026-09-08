import { tool } from "ai";
import { z } from "zod";
import { createConnection } from "net";
import { connect as tlsConnect } from "tls";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { parseIrcLine } from "../interfaces/irc.js";
import type { IrcInterface, IrcLine } from "../interfaces/irc.js";

let _agentDir = "";
let _ircBot: IrcInterface | null = null;

export function initIrcTool(agentDir: string, ircBot?: IrcInterface | null) {
  _agentDir = agentDir;
  _ircBot = ircBot || null;
}

export function setIrcInterface(ircBot: IrcInterface | null) {
  _ircBot = ircBot;
}

/**
 * Perform a simple, isolated IRC probe/handshake via raw TCP/TLS socket.
 */
function runProbeSocket(opts: {
  host: string;
  port: number;
  tls?: boolean;
  timeoutMs?: number;
  onConnect?: (send: (line: string) => void) => void;
  onLine?: (line: IrcLine, send: (line: string) => void) => boolean | void;
}): Promise<{ lines: string[]; error?: string }> {
  return new Promise((resolve) => {
    const { host, port, tls, timeoutMs = 8000 } = opts;
    const socket = tls ? tlsConnect({ host, port, servername: host }) : createConnection({ host, port });
    const collected: string[] = [];
    let buffer = "";
    let settled = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve({ lines: collected, error });
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish("Connection timed out"));
    socket.on("error", (err) => finish(err.message));

    const send = (line: string) => {
      try {
        if (!socket.destroyed) socket.write(`${line}\r\n`);
      } catch {}
    };

    socket.on(tls ? "secureConnect" : "connect", () => {
      if (opts.onConnect) {
        opts.onConnect(send);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\r\n");
      buffer = parts.pop() ?? "";
      for (const raw of parts) {
        if (!raw) continue;
        collected.push(raw);
        const parsed = parseIrcLine(raw);
        if (parsed) {
          if (parsed.command === "PING") {
            send(`PONG :${parsed.params[0] || ""}`);
          }
          if (opts.onLine) {
            const stop = opts.onLine(parsed, send);
            if (stop === true) {
              return finish();
            }
          }
        }
      }
    });

    socket.on("close", () => finish());
  });
}

export const ircTool = tool({
  description:
    "Manage IRC connection, configuration, and send IRC protocol commands (e.g. WHOIS, NAMES, JOIN, PART, PRIVMSG NickServ, MODE).",
  inputSchema: z.object({
    action: z
      .enum(["probe", "register", "configure", "send"])
      .describe(
        "probe: test IRC server connectivity and features. register: register nick with NickServ during setup. configure: format and write connection URL to config. send: send a raw IRC command to the running interface and capture response lines.",
      ),
    command: z
      .string()
      .optional()
      .describe("Raw IRC command to send (for send action, e.g. 'WHOIS Atlas', 'NAMES #homelab', 'JOIN #dev', 'PRIVMSG NickServ :IDENTIFY pass')"),
    host: z.string().optional().describe("IRC server hostname (for probe, register, configure, or targeting specific connection in send)"),
    port: z.number().optional().describe("IRC server port (default: 6667 plain, 6697 TLS)"),
    tls: z.boolean().optional().describe("Use TLS/SSL (default: true if port is 6697, false otherwise)"),
    nick: z.string().optional().describe("Nickname (for register or configure)"),
    password: z.string().optional().describe("Account password (for register or configure)"),
    email: z.string().optional().describe("Optional email address for NickServ registration"),
    channels: z.string().optional().describe("Comma-separated list of channels to join, e.g. '#homelab,#general'"),
  }),
  execute: async ({ action, command, host, port, tls, nick, password, email, channels }) => {
    switch (action) {
      case "probe": {
        if (!host) return "Error: host is required for probe";
        const useTls = tls ?? (port === 6697);
        const targetPort = port ?? (useTls ? 6697 : 6667);
        const probeNick = `probe_${Math.floor(Math.random() * 10000)}`;

        let welcomeReceived = false;
        let serverName = "";
        let caps: string[] = [];

        const res = await runProbeSocket({
          host,
          port: targetPort,
          tls: useTls,
          onConnect: (send) => {
            send("CAP LS 302");
            send(`NICK ${probeNick}`);
            send(`USER ${probeNick} 0 * :kern probe`);
          },
          onLine: (line, send) => {
            if (line.command === "CAP") {
              const list = (line.params[line.params.length - 1] || "").split(/\s+/).filter(Boolean);
              caps.push(...list);
              if (line.params[2] !== "*") send("CAP END");
            } else if (line.command === "001") {
              welcomeReceived = true;
              serverName = line.params[0] || "";
              send("QUIT :probe complete");
              return true;
            } else if (line.command === "433") {
              // Nick in use, still reachable
              send("QUIT :probe complete");
              return true;
            }
          },
        });

        if (res.error && !welcomeReceived && caps.length === 0) {
          return `Probe failed: ${res.error}`;
        }

        return [
          `Probe successful for ${host}:${targetPort} (TLS: ${useTls})`,
          caps.length ? `Capabilities: ${caps.join(", ")}` : "Capabilities: none announced",
          welcomeReceived ? `Server handshake: OK (${serverName})` : "Server handshake: connected",
        ].join("\n");
      }

      case "register": {
        if (!host) return "Error: host is required for register";
        if (!nick) return "Error: nick is required for register";
        if (!password) return "Error: password is required for register";

        const useTls = tls ?? (port === 6697);
        const targetPort = port ?? (useTls ? 6697 : 6667);

        const nickservResponses: string[] = [];
        let done = false;

        const res = await runProbeSocket({
          host,
          port: targetPort,
          tls: useTls,
          timeoutMs: 12000,
          onConnect: (send) => {
            send("CAP LS 302");
            send(`NICK ${nick}`);
            send(`USER ${nick} 0 * :kern agent`);
          },
          onLine: (line, send) => {
            if (line.command === "CAP" && line.params[2] !== "*") {
              send("CAP END");
            } else if (line.command === "001") {
              // Registration on server complete, now send NickServ command
              const emailPart = email ? ` ${email}` : "";
              send(`PRIVMSG NickServ :REGISTER ${password}${emailPart}`);
            } else if (line.command === "NOTICE") {
              const text = line.params[1] || "";
              nickservResponses.push(text);
              if (
                /registered|account created|verify|check your email|password/i.test(text) ||
                /already registered|taken|invalid/i.test(text)
              ) {
                done = true;
                send("QUIT :registration complete");
                return true;
              }
            } else if (line.command === "433") {
              nickservResponses.push(`Nickname ${nick} is already in use`);
              send("QUIT :nick in use");
              return true;
            }
          },
        });

        if (res.error && !done && nickservResponses.length === 0) {
          return `Registration attempt failed: ${res.error}`;
        }

        return [
          `Registration attempt for ${nick} on ${host}:`,
          ...(nickservResponses.length ? nickservResponses.map((r) => `  ${r}`) : ["  No explicit NickServ notice captured."]),
        ].join("\n");
      }

      case "configure": {
        if (!host) return "Error: host is required for configure";
        const useTls = tls ?? (port === 6697);
        const targetPort = port ?? (useTls ? 6697 : 6667);
        const targetNick = nick || "kern";

        // URL format: irc[s]://[nick[:account%3Apassword]@]host[:port]/#chan1,#chan2
        let userAuth = encodeURIComponent(targetNick);
        if (password) {
          // If password contains colons or special chars, encodeURIComponent.
          // Colon between account and password must be %3A.
          const encPass = encodeURIComponent(`${targetNick}:${password}`);
          userAuth = `${encodeURIComponent(targetNick)}:${encPass}`;
        }

        const scheme = useTls ? "ircs" : "irc";
        const portStr = (useTls && targetPort === 6697) || (!useTls && targetPort === 6667) ? "" : `:${targetPort}`;
        const chanList = channels
          ? channels
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => (/^[#&]/.test(c) ? c : `#${c}`))
              .join(",")
          : "#homelab";

        const ircUrl = `${scheme}://${userAuth}@${host}${portStr}/${chanList}`;

        // Save into .kern/config.json
        try {
          const kernDir = join(_agentDir, ".kern");
          await mkdir(kernDir, { recursive: true });
          const configPath = join(kernDir, "config.json");
          let cfg: any = {};
          try {
            cfg = JSON.parse(await readFile(configPath, "utf-8"));
          } catch {}

          cfg.irc = ircUrl;
          await writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

          return [
            `Configured IRC connection URL:`,
            `  ${scheme}://${targetNick}:***@${host}${portStr}/${chanList}`,
            `Saved to .kern/config.json. Restart the agent (/restart) for the interface to connect.`,
          ].join("\n");
        } catch (err: any) {
          return `Failed to save configuration: ${err.message || err}`;
        }
      }

      case "send": {
        if (!command) return "Error: command is required for send (e.g. 'WHOIS nick' or 'NAMES #chan')";
        if (!_ircBot) return "Error: IRC interface is not running on this agent";

        const clean = command.trim();
        // Prevent CRLF injection
        if (/[\r\n]/.test(clean)) {
          return "Error: command must not contain carriage return or newline characters";
        }

        // Prevent destructive QUIT via send
        if (/^QUIT(\s|$)/i.test(clean)) {
          return "Error: QUIT command cannot be sent via irc tool as it terminates the connection";
        }

        const res = await _ircBot.sendCommand(clean, host);
        if (!res.success) {
          return `Command failed: ${res.error || "failed to send command"}`;
        }

        if (!res.lines || res.lines.length === 0) {
          return `Command sent: ${clean} (no server reply received)`;
        }

        return res.lines.join("\n");
      }
    }
  },
});
