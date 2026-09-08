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

test("ircTool: join, part, names, whois delegate cleanly to ircBot", async () => {
  let lastRaw = "";
  const fakeBot: any = {
    raw(line: string) {
      lastRaw = line;
      return true;
    },
    async queryNames(channel: string) {
      return { success: true, nicks: ["alice", "bob"] };
    },
    async queryWhois(target: string) {
      return {
        success: true,
        info: { nick: target, user: "u", host: "h.net", account: target, realname: "Real Name" },
      };
    },
  };

  setIrcInterface(fakeBot);

  const joinRes = await (ircTool as any).execute({ action: "join", channel: "#test" });
  assert.equal(joinRes, "Joined #test");
  assert.equal(lastRaw, "JOIN #test");

  const partRes = await (ircTool as any).execute({ action: "part", channel: "#test", reason: "bye" });
  assert.equal(partRes, "Parted #test");
  assert.equal(lastRaw, "PART #test :bye");

  const namesRes = await (ircTool as any).execute({ action: "names", channel: "#test" });
  assert.match(namesRes, /Users in #test \(2\):/);
  assert.match(namesRes, /alice, bob/);

  const whoisRes = await (ircTool as any).execute({ action: "whois", target: "alice" });
  assert.match(whoisRes, /WHOIS alice:/);
  assert.match(whoisRes, /Account: alice \(Identified\)/);
});
