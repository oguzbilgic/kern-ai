import test from "node:test";
import assert from "node:assert/strict";
import { ircTool, initIrcTool, setIrcInterface } from "../src/tools/irc.js";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("ircTool: configure action formats URL and writes to config.json", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "kern-irc-tool-test-"));
  try {
    initIrcTool(tmp);
    const res = await (ircTool as any).execute({
      action: "configure",
      host: "irc.example.com",
      port: 6667,
      tls: false,
      nick: "mybot",
      password: "secret:password",
      channels: "#homelab,#dev",
    });

    assert.match(res, /Configured IRC connection URL/);
    const cfg = JSON.parse(await readFile(join(tmp, ".kern", "config.json"), "utf-8"));
    assert.equal(cfg.irc, "irc://mybot:mybot%3Asecret%3Apassword@irc.example.com/#homelab,#dev");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ircTool: send action executes raw command and returns server response lines", async () => {
  let lastSentCommand = "";
  const fakeBot: any = {
    async sendCommand(cmd: string) {
      lastSentCommand = cmd;
      if (cmd.startsWith("WHOIS")) {
        return {
          success: true,
          lines: [
            ":irc 311 bot alice ~u host * :Real Name",
            ":irc 330 bot alice alice :is logged in as",
            ":irc 318 bot alice :End of /WHOIS list.",
          ],
        };
      }
      if (cmd.startsWith("PRIVMSG NickServ")) {
        return {
          success: true,
          lines: [":NickServ NOTICE bot :You are now identified for alice."],
        };
      }
      return { success: true, lines: [] };
    },
  };

  setIrcInterface(fakeBot);

  // Rejects CRLF injection
  const crlfRes = await (ircTool as any).execute({ action: "send", command: "WHOIS alice\r\nQUIT" });
  assert.match(crlfRes, /carriage return or newline/);

  // Rejects QUIT
  const quitRes = await (ircTool as any).execute({ action: "send", command: "QUIT :bye" });
  assert.match(quitRes, /QUIT command cannot be sent/);

  // Executes WHOIS
  const whoisRes = await (ircTool as any).execute({ action: "send", command: "WHOIS alice" });
  assert.equal(lastSentCommand, "WHOIS alice");
  assert.match(whoisRes, /311 bot alice/);
  assert.match(whoisRes, /is logged in as/);

  // Executes NickServ IDENTIFY
  const idRes = await (ircTool as any).execute({ action: "send", command: "PRIVMSG NickServ :IDENTIFY secretpass" });
  assert.equal(lastSentCommand, "PRIVMSG NickServ :IDENTIFY secretpass");
  assert.match(idRes, /You are now identified/);
});
