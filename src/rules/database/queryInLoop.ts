import type { Node } from "web-tree-sitter";
import type { Confidence } from "../confidence.ts";
import { lineOf, walk, type FileContext, type LineFinding } from "../line/types.ts";

// A query inside a loop (the "N+1" problem): one round trip to the database per item instead
// of one for all of them. Fast on 10 test rows, slow on 10,000 real ones.

const JS_LOOPS = new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]);
const PY_LOOPS = new Set(["for_statement", "while_statement", "list_comprehension", "dictionary_comprehension", "set_comprehension", "generator_expression"]);
const ITERATORS = /\.(forEach|map|flatMap|filter|reduce|some|every)$/;
const FUNCTIONS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition", "function_definition", "lambda"]);

const DB_METHODS = "find|findOne|findById|findByPk|findAll|findMany|findUnique|findFirst|findOneBy|findBy|count|countDocuments|aggregate|create|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|destroy|save|query|execute|raw|select|where";
// PascalCase built-ins that share method names with models: Object.create, Array.find...
const BUILT_INS = new Set(["Object", "Array", "Promise", "JSON", "Math", "Reflect", "Date", "Number", "String", "Map", "Set", "Symbol", "Intl", "URL", "Buffer", "Atomics"]);
// One-off scripts: inserting row by row while seeding or migrating is fine.
const ONE_OFF = /(^|\/)(seeds?|seeders?|migrations?|scripts?|fixtures)\/|(^|\/)seed[\w.-]*\.[\w]+$/i;
// Prisma, Knex, pg pools, TypeORM repositories, Mongo collections.
const JS_CLIENT = /^(this\.)?(prisma|db|knex|pool|sql|database|conn|connection|\w*[Rr]epository|\w*[Rr]epo)\b/;
// Mongoose / Sequelize models: User.find(), Order.findByPk(). Not constants (TOKEN_RE).
const JS_MODEL = new RegExp(`^([A-Z][a-z]\\w*)\\.(${DB_METHODS})$`);
// Django X.objects.filter(), SQLAlchemy session.query()/execute(), pymongo collection.find_one().
const PY_CALL = /\.objects\.\w+$|^(self\.)?(db\.)?(session|db|cursor|conn|connection)\.(query|execute|get|scalars?|scalar|exec)$|\.(find_one|insert_one|update_one|delete_one|count_documents)$/;
// find() and aggregate() are also str.find() and ElementTree's el.find(): only on something
// that looks like a Mongo collection (db.users, db["users"], users_collection).
const PY_MONGO = /(^|\.)(db|database|mongo|\w*coll(ection)?s?)(\[[^\]]+\]|\.\w+)*\.(find|aggregate)$/i;

function isDbCall(call: Node, python: boolean): boolean {
  const callee = call.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
  if (python) return PY_CALL.test(callee) || PY_MONGO.test(callee);
  const method = /\.(\w+)$/.exec(callee)?.[1] ?? "";
  const model = JS_MODEL.exec(callee)?.[1];
  return (!!model && !BUILT_INS.has(model)) || (JS_CLIENT.test(callee) && new RegExp(`^(${DB_METHODS})$`).test(method));
}

// The body a loop runs: the loop itself, or the callback of items.forEach(...)/map(...).
function loopBodies(root: Node, python: boolean): { body: Node; parallel: boolean }[] {
  const bodies: { body: Node; parallel: boolean }[] = [];
  for (const node of walk(root)) {
    if ((python ? PY_LOOPS : JS_LOOPS).has(node.type)) bodies.push({ body: node, parallel: false });
    if (!python && node.type === "call_expression" && ITERATORS.test(node.childForFieldName("function")?.text ?? "")) {
      const callback = node.childForFieldName("arguments")?.namedChildren.find((a) => FUNCTIONS.has(a.type));
      // Promise.all(items.map(async ...)): still one query per item, just at the same time.
      const parallel = /^Promise\.all(Settled)?$/.test(node.parent?.parent?.childForFieldName("function")?.text ?? "");
      if (callback) bodies.push({ body: callback, parallel });
    }
  }
  return bodies;
}

// Walking a tree one level per query: the query uses a variable the loop sets from the
// last result (`id = item.parentId`) or takes from a queue (`queue.shift()`). It can't be
// batched; a recursive query can replace it (SQL Antipatterns, ch. 3 "Naive Trees").
function walksATree(call: Node, body: Node): boolean {
  const used = new Set([...walk(call.childForFieldName("arguments") ?? call)].filter((n) => n.type === "identifier").map((n) => n.text));
  return [...walk(body)].some((n) => {
    const target = n.type === "assignment_expression" || n.type === "assignment" ? n.childForFieldName("left") : n.type === "variable_declarator" ? n.childForFieldName("name") : null;
    if (!target || !used.has(target.text)) return false;
    const value = n.childForFieldName(n.type === "variable_declarator" ? "value" : "right");
    return n.type !== "variable_declarator" || /\.(shift|pop)\(\)$/.test(value?.text ?? "");
  });
}

// Calls inside `body`, without going into functions defined there (they may never run in the loop).
function* callsIn(node: Node, top = true): Generator<Node> {
  if (!top && FUNCTIONS.has(node.type)) return;
  if (node.type === "call_expression" || node.type === "call") yield node;
  for (const child of node.namedChildren) yield* callsIn(child, false);
}

export function queryInLoopRule({ parsed, file }: FileContext): LineFinding[] {
  if (ONE_OFF.test(file)) return [];
  const python = parsed.language === "python";
  const seen = new Set<number>();
  const found: LineFinding[] = [];
  for (const { body, parallel } of loopBodies(parsed.tree.rootNode, python)) {
    for (const call of callsIn(body)) {
      if (!isDbCall(call, python) || seen.has(call.startIndex)) continue;
      seen.add(call.startIndex);
      const callee = call.childForFieldName("function")!.text.replace(/\s+/g, "");
      if (walksATree(call, body)) {
        found.push({ rule: "tree-walk-queries", file, line: lineOf(call), confidence: "maybe", message: `${callee}() walks a tree one query per level (each query needs the last one's result)` });
        continue;
      }
      const confidence: Confidence = parallel ? "maybe" : "likely";
      found.push({
        rule: "query-in-loop", file, line: lineOf(call), confidence,
        message: `${callee}() runs once per item of the loop at line ${lineOf(body)}${parallel ? " (in parallel, but still one query each)" : ""}`,
      });
    }
  }
  return found;
}
