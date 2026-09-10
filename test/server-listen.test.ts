import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentServer } from "../src/server.js";

test("AgentServer: retries on EADDRINUSE and succeeds once port is free", async () => {
  const blocker = http.createServer();
  // Bind blocker to an ephemeral port assigned by OS
  const testPort = await new Promise<number>((resolve) => {
    blocker.listen(0, "127.0.0.1", () => {
      resolve((blocker.address() as any).port);
    });
  });

  // Release the port after 200ms
  setTimeout(() => {
    blocker.close();
  }, 200);

  const server = new AgentServer();
  const boundPort = await server.start("127.0.0.1", testPort, 8, 50);

  assert.equal(boundPort, testPort);
  server.stop();
});

test("AgentServer: throws error if EADDRINUSE persists after max retries", async () => {
  const blocker = http.createServer();
  const testPort = await new Promise<number>((resolve) => {
    blocker.listen(0, "127.0.0.1", () => {
      resolve((blocker.address() as any).port);
    });
  });

  const server = new AgentServer();

  await assert.rejects(
    async () => {
      await server.start("127.0.0.1", testPort, 2, 50);
    },
    (err: any) => {
      assert.equal(err.code, "EADDRINUSE");
      return true;
    }
  );

  blocker.close();
  server.stop();
});
