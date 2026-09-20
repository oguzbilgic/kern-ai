import test from "node:test";
import assert from "node:assert/strict";
import { systemServiceTemplate } from "../src/install.js";

test("kern@.service: starts as root and drops in-process (no User=), hardened", () => {
  const unit = systemServiceTemplate("/usr/bin/node", "/usr/lib/node_modules/kern-ai/dist/index.js");
  assert.match(unit, /^ExecStart=\/usr\/bin\/node --no-deprecation \/usr\/lib\/node_modules\/kern-ai\/dist\/index\.js run %i$/m);
  // Privilege drop happens inside `kern run`; a User= line would break reading the 0600 registry.
  assert.doesNotMatch(unit, /^User=/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^PrivateTmp=yes$/m);
  assert.match(unit, /^ProtectSystem=full$/m);
  assert.match(unit, /^After=network-online\.target$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});
