import type { Node } from "web-tree-sitter";
import { isTestFile } from "../../index/files.ts";
import type { Confidence } from "../confidence.ts";
import { collector, walk, type FileContext, type LineFinding } from "../line/types.ts";

// Secrets in code (400+ exposed in 5,600 vibe-coded apps, Escape 2025; keys in frontend
// bundles behind the Moltbook and Lovable leaks): hardcoded keys, known fallbacks, and secret
// keys handed to the browser.

// Formats that are always secret. Not Firebase web keys (AIza...) or Supabase anon keys:
// those are public by design.
const KEY_FORMATS: [RegExp, string][] = [
  [/\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/, "an OpenAI/Anthropic API key"],
  [/\b(sk|rk)_live_[0-9A-Za-z]{20,}/, "a Stripe live secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b(ghp|gho|ghs)_[A-Za-z0-9]{36}\b|\bgithub_pat_\w{40,}/, "a GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "a SendGrid key"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "a private key"],
  [/\b(mongodb(\+srv)?|postgres(ql)?|mysql|redis|amqp):\/\/[^:\s/"'`]+:[^@\s"'`]{3,}@/, "a database URL with its password"],
];
const SECRET_NAME = /(secret|passw(or)?d|pwd|api_?key|apikey|access_?key|private_?key|client_?secret|auth_?token|token_?secret|signing_?key|encryption_?key)$/i;
const PLACEHOLDER = /your|example|xxx|placeholder|change[_-]?me|dummy|sample|test|fake|<|\$\{|\*\*\*|todo|replace|insert|redacted|^[a-z_]+$/i;
const STRINGS = new Set(["string", "template_string"]);

const unquote = (text: string) => text.replace(/^[a-z]*['"`]{1,3}|['"`]{1,3}$/gi, "");

// The role inside a Supabase-style JWT: "service_role" is a secret, "anon" is public.
function jwtRole(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { role?: string };
    return payload.role;
  } catch {
    return undefined; // not a JWT we can read: no role to report
  }
}

// The name a value is assigned to: const API_KEY = "...", { apiKey: "..." }, SECRET_KEY = "...".
function assignedName(node: Node): string | undefined {
  const p = node.parent;
  if (!p) return undefined;
  if (p.type === "variable_declarator") return p.childForFieldName("name")?.text;
  if (p.type === "pair") return p.childForFieldName("key")?.text.replace(/['"]/g, "");
  if (p.type === "assignment" || p.type === "assignment_expression") return p.childForFieldName("left")?.text.split(".").at(-1);
  if (p.type === "keyword_argument") return p.childForFieldName("name")?.text;
  return undefined;
}

const looksRandom = (value: string) => value.length >= 16 && /[A-Za-z]/.test(value) && /\d/.test(value) && !/\s/.test(value);

function secretIn(node: Node): { what: string; confidence: Confidence } | undefined {
  const value = unquote(node.text);
  for (const [format, what] of KEY_FORMATS) if (format.test(value)) return { what, confidence: "likely" };
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.exec(value)?.[0];
  if (jwt && jwtRole(jwt) === "service_role") return { what: "a Supabase service_role key (full database access)", confidence: "likely" };
  const name = assignedName(node);
  // Firebase web config ({ apiKey: "AIza...", authDomain }) and Stripe pk_ keys are meant to be public.
  const publicKey = /^(AIza|pk_(live|test)_)/.test(value) || /authDomain|projectId|messagingSenderId/.test(node.parent?.parent?.text.slice(0, 600) ?? "");
  if (name && SECRET_NAME.test(name) && looksRandom(value) && !PLACEHOLDER.test(value) && !publicKey) return { what: `a secret in ${name}`, confidence: "likely" };
  return undefined;
}

// process.env.JWT_SECRET || "secret", os.getenv("SECRET_KEY", "dev"): production quietly runs
// with a key anyone can read here.
const ENV_JS = /^(process\.env|import\.meta\.env)\.(\w*(SECRET|KEY|TOKEN|PASSWORD|PASS)\w*)$/i;
// Public by design: browser env vars, site keys, publishable keys.
const PUBLIC_NAME = /^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC|NUXT_PUBLIC)_|SITE_?KEY|PUBLISHABLE|PUBLIC_?KEY|ANON_?KEY/i;
const ENV_PY = /^(os\.getenv|os\.environ\.get|config)$/;
const SECRET_ENV = /^\w*(SECRET|KEY|TOKEN|PASSWORD)\w*$/i;
// Env vars the bundler puts into the browser.
const PUBLIC_ENV = /\b(process\.env|import\.meta\.env)\.((NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC|NUXT_PUBLIC)_\w*(SECRET|SERVICE_ROLE|PRIVATE|OPENAI|ANTHROPIC|STRIPE_SECRET|SK_|DATABASE|DB_PASS|ADMIN)\w*)/;

// process.env.X || "..." and os.environ.get("X", "..."): the env var's name, and whether the
// fallback is empty. Only the read itself, not every expression around it (one finding each).
function fallbackOf(node: Node): { name: string; empty: boolean } | undefined {
  if (node.type === "binary_expression" && /^(\|\||\?\?)$/.test(node.childForFieldName("operator")?.text ?? "")) {
    const name = ENV_JS.exec(node.childForFieldName("left")?.text.replace(/\s+/g, "") ?? "")?.[2];
    const right = node.childForFieldName("right");
    if (name && right && STRINGS.has(right.type)) return { name, empty: unquote(right.text) === "" };
  }
  if (node.type === "call" && ENV_PY.test(node.childForFieldName("function")?.text ?? "")) {
    const [key, value] = node.childForFieldName("arguments")?.namedChildren ?? [];
    const name = key?.type === "string" ? unquote(key.text) : undefined;
    if (name && SECRET_ENV.test(name) && value?.type === "string") return { name, empty: unquote(value.text) === "" };
  }
  return undefined;
}

export function secretRules({ parsed, file }: FileContext): LineFinding[] {
  if (isTestFile(file) || /(^|\/)(\w+\.)?(example|sample|template|fixtures?)\b/i.test(file)) return [];
  const { found, add } = collector(file);
  for (const node of walk(parsed.tree.rootNode)) {
    if (STRINGS.has(node.type) && !STRINGS.has(node.parent?.type ?? "")) {
      const secret = secretIn(node);
      if (secret) add(node, "hardcoded-secret", secret.confidence, `${secret.what} is written in the code`);
      // Django's generated key is a placeholder that's easy to ship.
      if (/^SECRET_KEY$/.test(assignedName(node) ?? "") && /django-insecure-/.test(node.text)) add(node, "secret-fallback", "likely", "Django's SECRET_KEY is the generated insecure one");
    }
    const fallback = fallbackOf(node);
    if (fallback && !PUBLIC_NAME.test(fallback.name)) {
      // "" is "not set": the code that uses it decides (a feature stays off, a check fails).
      // Only a hint, since an empty key that's still used to sign or verify is a real hole.
      if (fallback.empty) add(node, "secret-fallback", "maybe", `${fallback.name} defaults to empty: check the code refuses to run without it`);
      else add(node, "secret-fallback", "likely", `${fallback.name} falls back to a value written in the code when it isn't set`);
    }
    if (node.type === "member_expression" && !(node.parent?.type === "member_expression")) {
      const m = PUBLIC_ENV.exec(node.text);
      if (m) add(node, "client-exposed-secret", "likely", `${m[2]} is a public env var: the bundler puts it in the JavaScript every visitor downloads`);
    }
  }
  return found;
}

// A .env file in the repo (or in a zip of it) shares every secret in it.
export function committedEnvFiles(allFiles: string[]): LineFinding[] {
  return allFiles
    .filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template|dist|defaults)$/.test(f))
    .map((file) => ({ rule: "env-file-in-repo", file, line: 1, confidence: "likely" as const, message: `${file} is part of the repo: every secret in it is shared with anyone who gets the code` }));
}
