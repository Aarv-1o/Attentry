import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex } from "../src/index/repo.ts";
import { findFunctionShapeIssues } from "../src/rules/codebase/functionShape.ts";
import { check, makeRepo } from "./helpers.ts";

test("catch blocks: JS", async () => {
  assert.deepEqual(await check("server/jobs.js", `
try { a(); } catch (e) { throw e; }
try { a(); } catch (err) { console.error("failed", err); }
try { a(); } catch {}
try { a(); } catch { /* ignore */ }
try { a(); } catch { /* best effort: the next sync retries */ }
function load() {
  try { return a(); } catch (e) { console.warn(e); return null; }
}
try { a(); } catch (e) { throw new Error("wrapped", { cause: e }); }
try { a(); } catch (e) { res.status(500).json({ error: e.message }); }
try { a(); } catch (e) {
  console.error(e); // the response is already sent, so logging is all we can do
}
`), [
    "2 catch-rethrow sure",
    "3 catch-only-logs maybe",
    "4 empty-catch likely",
    "5 empty-catch likely",
    "8 catch-returns-default maybe",
  ]);
});

test("catch blocks: an error only logged in browser code is one the user never sees", async () => {
  assert.deepEqual(await check("src/pages/Inbox.tsx", 'try { a(); } catch (e) { console.error("Failed to delete", e); }\n'), [
    "1 catch-only-logs likely",
  ]);
});

test("catch blocks: Python", async () => {
  assert.deepEqual(await check("agents/utils.py", `
try:
    a()
except Exception:
    pass

try:
    a()
except json.JSONDecodeError:
    pass

try:
    a()
except Exception as e:
    raise

try:
    a()
except ValueError:
    raise
except Exception as e:
    print(e)

def search(q):
    try:
        return a(q)
    except Exception as e:
        print(f"Request error: {e}")
        return None
`), [
    "4 empty-catch likely",
    "9 empty-catch maybe",
    "14 catch-rethrow sure",
    "21 catch-only-logs maybe",
    "27 catch-returns-default maybe",
  ]);
});

test("commented-out code: blocks are sure, single lines likely, prose and directives skipped", async () => {
  assert.deepEqual(await check("agents/chatbot.py", `
# checkpointer = InMemorySaver()

# builder = StateGraph(AgentState)
# builder.add_node("Chatbot", chatbot_node)
x = 1
#search_key=os.getenv("SEARCH_KEY")
# html=True enables serving index.html for directory paths
# TODO: x = compute()
y = 2  # noqa: E501
`, "commented-out-code"), ["2 commented-out-code sure", "7 commented-out-code likely"]);

  assert.deepEqual(await check("src/app.ts", `
// const old = load();
// eslint-disable-next-line no-console
// lets a broker dismiss it early; it stays hidden afterwards
// return cached;
const a = 1;
`, "commented-out-code"), ["2 commented-out-code likely", "5 commented-out-code likely"]);

  // An indented example inside prose explains the text around it.
  assert.deepEqual(await check("app/mcp.py", `
# The allowed hosts are explicit and configurable:
#
#   ZX_MCP_ALLOWED_HOSTS=rooms.example.com,api.example.com
#
# A transform from a shape's space into the slide:
#   slide_x = ox + child_x * sx
x = 1
`, "commented-out-code"), []);
});

test("comments that repeat the code, but not ones that explain why, or section headers", async () => {
  assert.deepEqual(await check("src/firebase.js", `
// Initialize Firebase
const app = initializeApp(firebaseConfig);
// Encrypt the access token for storage
const encryptedToken = encrypt(accessToken);
// Retry once because the first call after deploy often times out
const res = await fetchClients();
// ─── Rate Limiting ───
const authLimiter = rateLimit({});
// Done
start();
// Load the client list
function loadClientList() {}
/* ΓöÇΓöÇΓöÇ Arrow Icon ΓöÇΓöÇΓöÇ */
const ArrowIcon = () => null;
// cancelled / expired → ended: revert to the free plan
const ENDED = ["cancelled", "expired"];
`, "comment-repeats-code"), ["2 comment-repeats-code likely", "4 comment-repeats-code likely"]);
});

async function shapeIssues(files: Record<string, string>): Promise<string[]> {
  const root = await makeRepo(files);
  return findFunctionShapeIssues((await buildIndex(root)).functions).map((f) => `${f.line} ${f.rule} ${f.confidence}`);
}

test("unused params: only trailing ones, only in functions nothing else calls with a fixed signature", async () => {
  assert.deepEqual(await shapeIssues({
    "server/gmail.js": [
      "function extractAttachments(payload, messageId) { return payload.parts; }", // sure: JS ignores extra args
      "function middle(a, b, c) { return a + c; }", // b is in the middle: removing it shifts c
      "function handler(req, res, next) { res.send(1); }", // passed to the router: fixed signature
      'router.get("/", handler);',
      "export function api(x, y) { return x; }", // exported: callers elsewhere
      "extractAttachments(p, id); middle(1, 2, 3);",
    ].join("\n"),
    "agents/graph.py": [
      "def route_after_tools(state):", // passed to LangGraph: fixed signature
      "    return 'orchestrator'",
      "",
      "graph.add_conditional_edges('tools', route_after_tools)",
      "",
      "def _fmt(text, width):", // Python: callers must change too, so only likely
      "    return text",
      "",
      "_fmt('a', 3)",
    ].join("\n"),
  }), ["6 unused-param likely", "1 unused-param sure"]);
});

test("deep nesting and long parameter lists", async () => {
  assert.deepEqual(await shapeIssues({
    "a.js": [
      "function deep(a) {",
      "  if (a) { for (const x of a) { while (x) { try { if (x.y) { go(); } } catch (e) { throw e; } } } }",
      "}",
      "function many(a, b, c, d, e) { return a + b + c + d + e; }",
      "deep(1); many(1, 2, 3, 4, 5);",
    ].join("\n"),
  }), ["1 deep-nesting likely", "4 long-params maybe"]);
});

test("a reason on the except line counts; a lint directive alone doesn't", async () => {
  assert.deepEqual(await check("a.py", `try:
    a()
except Exception:  # noqa: BLE001 the DB is already down: keep the first error
    pass
try:
    a()
except Exception:  # noqa: BLE001
    pass
`, "empty-catch"), ["7 empty-catch likely"]);
});
