import assert from "node:assert/strict";
import { test } from "node:test";
import { usesDatabase } from "../src/rules/database/index.ts";
import { isMoneyName, moneyInSchemaText } from "../src/rules/database/money.ts";
import { check } from "./helpers.ts";

test("money names: price, amount, totalPrice; not counts, rates, ratings or cents", () => {
  for (const name of ["price", "unitPrice", "total_amount", "taxPrice", "shipping_cost", "balance", "budget", "totalPrice"]) assert.ok(isMoneyName(name), name);
  for (const name of ["total", "totalUsed", "priceCents", "amount_in_cents", "taxRate", "rating", "count", "priceId", "currency", "lat"]) assert.ok(!isMoneyName(name), name);
});

test("money as float: Mongoose (hint), Sequelize, TypeORM, Django, SQLAlchemy, SQLModel, Prisma, SQL", async () => {
  assert.deepEqual(await check("m.js", `const s = new mongoose.Schema({ price: { type: Number, required: true }, rating: Number, qty: Number });\n`, "money-float"), ["1 money-float maybe"]);
  assert.deepEqual(await check("s.js", `Order.init({ amount: DataTypes.FLOAT, total: DataTypes.FLOAT, priceCents: DataTypes.INTEGER }, { sequelize });\n`, "money-float"), ["1 money-float likely"]);
  assert.deepEqual(await check("e.ts", `@Entity() export class Order {\n  @Column("float") price: number;\n  @Column({ type: "decimal", precision: 12, scale: 2 }) total: string;\n  @Column("double") latitude: number;\n}\n`, "money-float"), ["2 money-float likely"]);
  assert.deepEqual(await check("models.py", `class Order(models.Model):\n    price = models.FloatField()\n    score = models.FloatField()\n    fee = models.DecimalField(max_digits=9, decimal_places=2)\n`, "money-float"), ["2 money-float likely"]);
  assert.deepEqual(await check("db.py", `class Item(Base):\n    cost = Column(Float)\n    balance: Mapped[float]\n    weight = Column(Float)\n`, "money-float"), ["2 money-float likely", "3 money-float likely"]);
  assert.deepEqual(await check("t.py", `class Item(SQLModel, table=True):\n    price: float\n`, "money-float"), ["2 money-float likely"]);
  assert.deepEqual(await check("schema.py", `class ItemIn(BaseModel):\n    price: float\n`, "money-float"), [], "a request schema, not a table");
  assert.deepEqual(moneyInSchemaText("schema.prisma", "model Order {\n  id Int @id\n  price Float\n  score Float\n}\n").map((f) => f.line), [3]);
  assert.deepEqual(moneyInSchemaText("init.sql", "CREATE TABLE t (\n  amount REAL,\n  ratio REAL,\n  fee NUMERIC(9,2)\n);\n").map((f) => f.line), [2]);
});

test("queries in loops: per-item queries are flagged; built-ins, tree walks and seed scripts are not N+1", async () => {
  const js = `export async function sync(clients) {
  for (const c of clients) {
    const found = await Contact.findOne({ email: c.email });
    if (!found) await Contact.create({ email: c.email });
    const parts = Object.create(null);
    while ((m = TOKEN_RE.exec(c.name))) parts[m[1]] = true;
  }
  await Promise.all(clients.map(async (c) => prisma.user.findUnique({ where: { id: c.id } })));
  let id = clients[0].id;
  for (let i = 0; i < 20; i++) { const item = await Item.findOne({ _id: id }); id = item.parentId; }
}
`;
  assert.deepEqual(await check("sync.js", js), [
    "3 query-in-loop likely", "4 query-in-loop likely", "8 query-in-loop maybe", "10 tree-walk-queries maybe",
  ]);
  assert.deepEqual(await check("scripts/seed.js", js, "query-in-loop"), []);
  const py = `def tags(posts):\n    for p in posts:\n        p.tags = Tag.objects.filter(post=p)\n    return [session.get(User, p.user_id) for p in posts]\n`;
  assert.deepEqual(await check("views.py", py), ["3 query-in-loop likely", "4 query-in-loop likely"]);
  // XML and strings have find() too: only collections are queries.
  const xml = `def parse(rows, users):\n    for r in rows:\n        r.find("w:t")\n        r.text.find("x")\n        db.users.find({"id": r.id})\n        users_collection.find_one({"id": r.id})\n`;
  assert.deepEqual(await check("docx_import.py", xml, "query-in-loop"), ["5 query-in-loop likely", "6 query-in-loop likely"]);
});

test("raw SQL: INSERT without columns, and hints for SELECT *, ORDER BY RAND(), LIKE '%...'", async () => {
  const js = `db.query("INSERT INTO users VALUES ($1, $2)", [a, b]);
db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [a, b]);
db.query(\`SELECT * FROM posts WHERE id = $1\`, [id]);
db.query("SELECT COUNT(*) FROM posts");
db.query("SELECT id FROM ads ORDER BY RAND() LIMIT 1");
db.query(\`SELECT id FROM bugs WHERE title LIKE '%\${q}%'\`);
db.query("SELECT id FROM bugs WHERE title LIKE ?", [q + "%"]);
Post.find({ title: { $regex: q, $options: "i" } });
`;
  assert.deepEqual(await check("q.js", js), [
    "1 insert-without-columns likely", "3 select-star maybe", "5 order-by-random maybe", "6 leading-wildcard-search maybe", "8 leading-wildcard-search maybe", "6 sql-injection maybe",
  ]);
  assert.deepEqual(await check("v.py", `Post.objects.filter(title__icontains=q, author=u)\n`), ["1 leading-wildcard-search maybe"]);
});

test("database checks only claim a result when there's a database library or schema", () => {
  const imp = (source: string) => [{ source, names: [], line: 1, bound: {} }];
  assert.ok(usesDatabase([imp("mongoose")], []));
  assert.ok(usesDatabase([imp("sqlalchemy.orm")], []));
  assert.ok(usesDatabase([imp("react")], ["prisma/schema.prisma"]));
  assert.ok(!usesDatabase([imp("react"), imp("axios")], ["src/a.ts"]));
});
