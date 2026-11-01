import type { Node } from "web-tree-sitter";
import type { Syntax } from "../../languages/types.ts";
import { collector, walk, type FileContext, type LineFinding } from "./types.ts";

const DEFAULT_RETURN = /^return\s*(null|undefined|None|\[\s*\]|\{\s*\}|''|""|false|False|0|-1)?\s*;?$/;

const statementsOf = (body: Node | undefined) => (body?.namedChildren ?? []).filter((s) => s.type !== "comment");
// A comment that says why ("best effort", "non-critical") makes it a decision, not a bug.
// "/* ignore */" only repeats what the empty block already says.
const NOT_A_REASON = new Set(["ignore", "ignored", "noop", "no-op", "empty", "nothing", "swallow", "silence", "todo"]);
// Lint directives (`# noqa: BLE001`) silence a linter; they don't say why.
const DIRECTIVES = /\b(noqa|pylint|pragma|type:\s*ignore|eslint[\w-]*)\b(:\s*[\w,-]+)?/gi;
// In the block, or on the catch line itself (`except Exception:  # the DB is already down`).
const givesReason = (clause: Node, body: Node | undefined, syntax: Syntax) =>
  [...clause.namedChildren, ...(body?.namedChildren ?? [])].some(
    (s) => s.type === "comment" && syntax.commentText(s.text).replace(DIRECTIVES, " ").toLowerCase().split(/\W+/).some((w) => w && !NOT_A_REASON.has(w)),
  );
const BROAD_ERRORS = /^\(?\s*(Exception|BaseException)\s*\)?$/;
const isLog = (statement: Node, syntax: Syntax) => statement.type === "expression_statement" && syntax.logCall.test(statement.text.trim());

function onlyRethrows(statements: Node[], variable: string | undefined, syntax: Syntax): boolean {
  if (statements.length !== 1 || statements[0]!.type !== syntax.throwStatement) return false;
  const thrown = statements[0]!.text.replace(/^(throw|raise)\s*/, "").replace(/;$/, "").trim();
  return thrown === "" || thrown === variable;
}

// Catch blocks that hide failures, or do nothing at all.
export function catchRules({ parsed, file, syntax, frontend }: FileContext): LineFinding[] {
  const { found, add } = collector(file);

  for (const node of walk(parsed.tree.rootNode)) {
    if (node.type !== syntax.catchClause) continue;
    const body = syntax.catchBody(node);
    const statements = statementsOf(body).filter((s) => s.type !== syntax.emptyStatement);
    const handlers = node.parent?.namedChildren.filter((c) => c.type === syntax.catchClause).length ?? 1;

    // A comment saying why makes any of these a decision, not a bug.
    if (givesReason(node, body, syntax)) continue;
    if (statements.length === 0) {
      const type = syntax.catchType(node);
      // Ignoring one named error (`except json.JSONDecodeError: pass`) is usually on purpose.
      const specific = type !== undefined && !BROAD_ERRORS.test(type);
      add(node, "empty-catch", specific ? "maybe" : "likely", "Error is silently ignored. Handle it, or add a comment saying why that's safe.");
    } else if (handlers === 1 && onlyRethrows(statements, syntax.catchVariable(node), syntax)) {
      // With several handlers, re-throwing one error type keeps it away from the next handler: that's deliberate.
      add(node, "catch-rethrow", "sure", "The catch only re-throws the error, so it does nothing. Remove it.");
    } else if (statements.every((s) => isLog(s, syntax))) {
      if (frontend) add(node, "catch-only-logs", "likely", "Error is only logged: the user never finds out it failed.");
      else add(node, "catch-only-logs", "maybe", "Error is only logged, then the code carries on as if it worked.");
    } else {
      const last = statements.at(-1)!;
      const loggedThenDefault = statements.slice(0, -1).every((s) => isLog(s, syntax)) && DEFAULT_RETURN.test(last.text.trim());
      if (loggedThenDefault) add(node, "catch-returns-default", "maybe", `Error becomes "${last.text.trim()}". Callers can't tell it failed.`);
    }
  }
  return found;
}
