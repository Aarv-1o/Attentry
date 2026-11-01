import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFunctions } from "../src/index/functions.ts";
import { parseSource, type LanguageId } from "../src/parse/parse.ts";

async function shapes(source: string, language: LanguageId): Promise<Record<string, string>> {
  const tree = await parseSource(source, language);
  try {
    const fns = extractFunctions({ path: "x", language, source, tree }, "x");
    return Object.fromEntries(fns.map((f) => [f.name, f.shape.join(" ")]));
  } finally {
    tree.delete();
  }
}

test("renamed copies get the same shape, whatever the function style", async () => {
  const s = await shapes(`
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  return diff < 60000 ? "Just now" : \`\${diff}ms\`;
}
const fileTimeAgo = (d) => {
  const delta = Date.now() - new Date(d).getTime();
  return delta < 60000 ? 'Just now' : \`\${delta}ms\`;
};`, "typescript");
  assert.equal(s.timeAgo, s.fileTimeAgo);
});

test("different literals give different shapes", async () => {
  const s = await shapes(`
function a(x) { return x < 60 ? "Just now" : "later"; }
function b(x) { return x < 45 ? "just now" : "later"; }`, "javascript");
  assert.notEqual(s.a, s.b);
});

test("comments don't change the shape", async () => {
  const s = await shapes(`
def a(x):
    # double it
    return x * 2

def b(y):
    return y * 2
`, "python");
  assert.equal(s.a, s.b);
});

test("opposite functions aren't copies: property names and outside calls are kept", async () => {
  const s = await shapes(`
const follow = async (name, id) => prisma.user.update({ where: { username: name }, data: { followedBy: { connect: { id } } } });
const unfollow = async (name, id) => prisma.user.update({ where: { username: name }, data: { followedBy: { disconnect: { id } } } });
function grow(items) { return items.push(Math.max(1, 2)); }
function shrink(items) { return items.pop(Math.min(1, 2)); }
function save(x) { return createUser(x); }
function remove(x) { return deleteUser(x); }
function renamed(list) { const { id } = list; for (const item of list) createUser(item, id); }
function renamedToo(rows) { const { id } = rows; for (const row of rows) createUser(row, id); }`, "javascript");
  assert.notEqual(s.follow, s.unfollow);
  assert.notEqual(s.grow, s.shrink);
  assert.notEqual(s.save, s.remove);
  assert.equal(s.renamed, s.renamedToo, "local names still don't matter");
  const py = await shapes(`
def follow(user_id):
    return db.table("follows").insert(user_id=user_id)

def unfollow(user_id):
    return db.table("follows").delete(user_id=user_id)

def again(uid):
    return db.table("follows").insert(user_id=uid)
`, "python");
  assert.notEqual(py.follow, py.unfollow);
  assert.equal(py.follow, py.again);
});

test("types don't change what code does: annotations and generics are left out", async () => {
  const ts = await shapes(`
const a = (user: any, id?: number) => ({ name: user.name, following: user.followedBy.some((f: any) => f.id === id) });
const b = (user: Partial<User>, id: number | undefined): Profile => ({ name: user.name, following: user.followedBy.some((f: Partial<User>) => f.id === id) });`, "typescript");
  assert.equal(ts.a, ts.b);
  const py = await shapes(`
def a(items: list[int]) -> int:
    return sum(items)

def b(values):
    return sum(values)
`, "python");
  assert.equal(py.a, py.b);
});
