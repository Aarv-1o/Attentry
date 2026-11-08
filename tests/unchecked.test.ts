import assert from "node:assert/strict";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { formatScan } from "../src/report/scan.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const REPO = {
  // Events registered from a map: no door Attentry can read, so still "not checked".
  "server/index.js": `import { Server } from "socket.io";\nconst io = new Server(3000);\nio.on("connection", (socket) => { for (const [name, fn] of Object.entries(handlers)) socket.on(name, fn); });\n`,
  "server/graphql.js": `import { ApolloServer } from "@apollo/server";\nexport const server = new ApolloServer({});\n`,
  "server/api.py": `from aiohttp import web\napp = web.Application()\n`,
  "client/src/socket.js": `import { io } from "socket.io-client";\nexport const socket = io();\n`,
};

test("blind spots: doors to the outside the security checks don't read are named, client libraries aren't", async () => {
  const scan = await scanRepo(await makeRepo(REPO));
  assert.deepEqual(scan.unchecked, [
    { label: "Socket.io event handlers", files: ["server/index.js"] },
    { label: "GraphQL resolvers", files: ["server/graphql.js"] },
    { label: "Python web routes (tornado, aiohttp, sanic or litestar)", files: ["server/api.py"] },
  ]);
  assert.match(formatScan(scan, false), /Not checked for security yet:\n {2}Socket\.io event handlers: server\/index\.js\n/);
  assert.deepEqual((await scanRepo(await makeRepo({ "client/src/socket.js": REPO["client/src/socket.js"] }))).unchecked, []);
});

test("blind spots: the check tool says what it couldn't check", async () => {
  const sessions = new Sessions(await makeRepo(REPO));
  assert.match((await sessions.tool("check", {})).text, /Not checked for security yet: Socket\.io event handlers \(server\/index\.js\); GraphQL resolvers/);
});
