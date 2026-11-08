import assert from "node:assert/strict";
import { test } from "node:test";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

// Each door is checked like a route: who's calling, whose record. One unsafe and one safe of each.
const security = async (files: Record<string, string>) =>
  (await scanRepo(await makeRepo({ "package.json": "{}", ...files }))).security.map((f) => `${f.rule} ${f.file}:${f.line} ${f.message}`);

test("Socket.io: an event beside routes that check login, but checking nothing itself", async () => {
  const found = await security({
    "server.js": `import express from "express";
import { Server } from "socket.io";
const app = express();
app.get("/api/orders", requireAuth, (req, res) => res.json([]));
const io = new Server(app.listen(3000));
io.on("connection", (socket) => {
  socket.on("ride:cancel", async ({ rideId }) => {
    await Ride.findByIdAndUpdate(rideId, { status: "cancelled" });
  });
  socket.on("rides:list", () => socket.emit("rides", []));
});
`,
  });
  assert.ok(found.some((f) => f.startsWith(`unauthenticated-route server.js:7 socket event "ride:cancel" changes data, and nothing checks who's calling`)), found.join("\n"));
  assert.ok(!found.some((f) => f.includes("rides:list")), "a read that returns nothing private");
});

test("Socket.io: login checked on connect, but the event loads any ride by the id it's sent", async () => {
  const found = await security({
    "server.js": `import { Server } from "socket.io";
const io = new Server(3000);
io.use((socket, next) => { socket.data.user = jwt.verify(socket.handshake.auth.token, SECRET); next(); });
io.on("connection", (socket) => {
  socket.on("ride:cancel", async ({ rideId }) => {
    await Ride.findByIdAndUpdate(rideId, { status: "cancelled" });
  });
  socket.on("ride:rate", async ({ rideId, stars }) => {
    await Ride.findOneAndUpdate({ _id: rideId, riderId: socket.data.user.id }, { stars });
  });
});
`,
  });
  assert.deepEqual(found.filter((f) => f.startsWith("missing-ownership-check")), [`missing-ownership-check server.js:5 socket event "ride:cancel" loads a record by an id the caller sends without checking it belongs to the caller`]);
  assert.ok(!found.some((f) => f.startsWith("unauthenticated-route")), "the connection checks login");
});

test("tRPC: a public mutation among protected procedures, and one that updates any post", async () => {
  const found = await security({
    "server/trpc.ts": `import { initTRPC } from "@trpc/server";
export const router = t.router({
  list: protectedProcedure.query(({ ctx }) => ctx.db.post.findMany({ where: { authorId: ctx.session.user.id } })),
  deletePost: publicProcedure.input(z.string()).mutation(({ input }) => db.post.delete({ where: { id: input } })),
  updatePost: protectedProcedure.input(z.object({ postId: z.string() })).mutation(({ input }) => db.post.update({ where: { id: input.postId }, data: input })),
  login: publicProcedure.input(z.object({ email: z.string() })).mutation(({ input }) => signIn(input)),
});
`,
  });
  assert.ok(found.some((f) => f.startsWith(`unauthenticated-route server/trpc.ts:4 tRPC procedure "deletePost" changes data`)), found.join("\n"));
  assert.ok(found.some((f) => f.startsWith(`missing-ownership-check server/trpc.ts:5 tRPC procedure "updatePost"`)), found.join("\n"));
  assert.ok(!found.some((f) => f.includes(`"login" changes data`)), "login is public");
});

test("GraphQL: a mutation that checks nothing, beside a query that reads the logged-in user", async () => {
  const found = await security({
    "server/schema.js": `import { ApolloServer } from "@apollo/server";
export const resolvers = {
  Query: {
    me: (_, __, context) => context.user,
  },
  Mutation: {
    deleteUser: (_, { id }) => User.findByIdAndDelete(id),
    updateProfile: requireAuth((_, args, context) => User.update(context.user.id, args)),
  },
};
`,
  });
  assert.ok(found.some((f) => f.startsWith(`unauthenticated-route server/schema.js:7 GraphQL mutation "deleteUser" changes data`)), found.join("\n"));
  assert.ok(!found.some((f) => f.includes("updateProfile")), "wrapped in requireAuth");
});

test("Next.js server actions: one checks the session, the other deletes any post", async () => {
  const found = await security({
    "app/actions.ts": `"use server";
import { auth } from "@/auth";
export async function createPost(data: FormData) {
  const session = await auth();
  if (!session) throw new Error("no");
  await db.post.create({ data: { title: data.get("title"), authorId: session.user.id } });
}
export async function deletePost(postId: string) {
  await db.post.delete({ where: { id: postId } });
}
`,
  });
  assert.ok(found.some((f) => f.startsWith(`unauthenticated-route app/actions.ts:8 server action "deletePost" changes data`)), found.join("\n"));
  assert.ok(!found.some((f) => f.includes("createPost")));
});

test("WebSocket (ws): messages from a connection that checks nothing; and the scan stops calling it unchecked", async () => {
  const files = {
    "server.js": `import express from "express";
import { WebSocketServer } from "ws";
const app = express();
app.post("/api/notes", requireAuth, (req, res) => res.json({}));
const wss = new WebSocketServer({ port: 8080 });
wss.on("connection", (ws) => {
  ws.on("message", async (data) => {
    const { noteId, text } = JSON.parse(data);
    await Note.findByIdAndUpdate(noteId, { text });
  });
});
`,
  };
  assert.ok((await security(files)).some((f) => f.startsWith("unauthenticated-route server.js:7 WebSocket messages changes data")));
  const scan = await scanRepo(await makeRepo({ "package.json": "{}", ...files }));
  assert.deepEqual(scan.unchecked, [], "read now: not a blind spot");
});

test("real-world patterns: the GraphQL context or Next.js middleware checks login for every door", async () => {
  // Apollo's tutorial: context reads the token for every resolver; `launch` reads public data.
  const apollo = await security({
    "server/index.js": `import { ApolloServer } from "@apollo/server";\nconst context = async ({ req }) => ({ user: await findUser(req.headers.authorization) });\nexport const server = new ApolloServer({ resolvers, context });\n`,
    "server/resolvers.js": `export const resolvers = {\n  Query: {\n    launch: (_, { id }, { dataSources }) => dataSources.launchAPI.getLaunchById({ launchId: id }),\n  },\n  Mutation: {\n    bookTrips: (_, { launchIds }, { dataSources }) => dataSources.userAPI.bookTrips({ launchIds }),\n  },\n};\n`,
  });
  assert.ok(!apollo.some((f) => /no-auth-at-all|unauthenticated-route|"launch"/.test(f)), apollo.join("\n"));
  // Next.js course: proxy.ts (middleware) runs NextAuth on every page; a form field named customerId isn't a record load.
  const next = await security({
    "proxy.ts": `import NextAuth from "next-auth";\nimport { authConfig } from "./auth.config";\nexport default NextAuth(authConfig).auth;\n`,
    "app/lib/actions.ts": `"use server";\nexport async function createInvoice(formData: FormData) {\n  const customerId = formData.get("customerId");\n  await sql\`INSERT INTO invoices (customer_id) VALUES (\${customerId})\`;\n}\n`,
  });
  assert.deepEqual(next, []);
});
