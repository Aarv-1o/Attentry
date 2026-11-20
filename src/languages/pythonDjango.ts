import type { Node } from "web-tree-sitter";
import { joinPaths } from "../rules/crossStack/paths.ts";
import type { FileApi } from "../rules/crossStack/types.ts";
import { descendants } from "./nodes.ts";

// Django: urlpatterns lists of path()/re_path()/url(), include() of other apps' urls, and
// Django REST Framework routers (router.register("articles", ArticleViewSet)).

const PATTERN = "urlpatterns";
const DRF_ROUTER = /^(DefaultRouter|SimpleRouter|ExtendedSimpleRouter)$/;

function text(node: Node | undefined): string | undefined {
  if (node?.type !== "string") return undefined;
  const parts = node.namedChildren;
  if (parts.some((p) => p.type === "interpolation")) return undefined;
  return parts.filter((p) => p.type === "string_content").map((p) => p.text).join("");
}

// r"^articles/(?P<slug>[-\w]+)/?$" -> "articles/:slug". undefined for regexes we can't turn into a path.
export function regexToPath(regex: string): string | undefined {
  const path = regex
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\/\?$/, "/")
    .replace(/\(\?P<(\w+)>(?:[^()]|\[[^\]]*\])*\)/g, ":$1");
  return /[\\[\]()*+?|^$]/.test(path) ? undefined : path;
}

const argsOf = (call: Node) => call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];

const keywordValue = (call: Node, key: string) =>
  argsOf(call).find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === key)?.childForFieldName("value") ?? undefined;

// What include() points at, and the namespace it gives. Its forms:
// include("app.urls"), include("app.urls", namespace="x"), include(("app.urls", "x")),
// include(router.urls), and patterns written in place: include(([path(...), ...], "x")).
interface Include { target?: string; inline?: Node; namespace?: string }
function includeOf(view: Node): Include | undefined {
  if (view.type !== "call" || view.childForFieldName("function")?.text !== "include") return undefined;
  let target = argsOf(view)[0];
  let namespace = text(keywordValue(view, "namespace"));
  if (target?.type === "tuple") {
    const [inner, name] = target.namedChildren;
    namespace ??= text(name);
    target = inner;
  }
  const found: Include = namespace ? { namespace } : {};
  const module = text(target);
  if (module) return { ...found, target: `require:${module}:${PATTERN}` }; // that app's urlpatterns
  if (target?.type === "list") return { ...found, inline: target };
  const router = target?.type === "attribute" && target.childForFieldName("attribute")?.text === "urls" ? target.childForFieldName("object")?.text : undefined;
  return router ? { ...found, target: router } : undefined;
}

// app_name = "notes" in a urls.py: the namespace of its route names, unless include() gives one.
const appName = (root: Node) => /^app_name\s*=\s*["']([^"']+)["']/m.exec(root.text)?.[1];

// `prefix` and `namespaces`: from include()s of patterns written in place, in this same file.
function patternEntry(entry: Node, api: FileApi, prefix = "", namespaces: string[] = []): void {
  const fn = entry.childForFieldName("function")?.text;
  if (fn !== "path" && fn !== "re_path" && fn !== "url") return;
  const [route, view] = argsOf(entry);
  const raw = text(route);
  if (raw === undefined || !view) return;
  const own = fn === "path" ? raw : regexToPath(raw);
  if (own === undefined) return;
  const path = prefix ? joinPaths(prefix, own) : own;
  const line = entry.startPosition.row + 1;
  if (view.text === "admin.site.urls") return; // Django's admin: pages people open, not an API
  const include = includeOf(view);
  if (include?.inline) {
    const inner = include.namespace ? [...namespaces, include.namespace] : namespaces;
    for (const e of include.inline.namedChildren) if (e.type === "call") patternEntry(e, api, path, inner);
    return;
  }
  if (include?.target) {
    api.mounts.push({ prefix: path, on: PATTERN, target: include.target, line, guards: [], ...(include.namespace ? { namespace: include.namespace } : {}) });
    return;
  }
  // A view takes every method it handles. Its guards are found where it's defined (views).
  const name = text(keywordValue(entry, "name"));
  api.routes.push({ method: "ALL", path, router: PATTERN, line, guards: [], handler: viewName(view), ...(name ? { name: [...namespaces, name].join(":") } : {}) });
}

// LoginView.as_view() -> LoginView; views.home -> home.
const viewName = (view: Node | undefined) => (view?.text ?? "").replace(/\.as_view\([\s\S]*$/, "").split(".").at(-1)!;

// Views defined in this file and what guards them: permission_classes, auth mixins, decorators.
function views(root: Node, api: FileApi): void {
  for (const node of descendants(root)) {
    const definition = node.type === "decorated_definition" ? node.childForFieldName("definition") : node;
    if (definition?.type !== "class_definition" && definition?.type !== "function_definition") continue;
    if (node.type !== "decorated_definition" && node.parent?.type === "decorated_definition") continue;
    const name = definition.childForFieldName("name")?.text;
    if (!name || api.views.has(name)) continue;
    const decorators = node.type === "decorated_definition" ? node.namedChildren.filter((d) => d.type === "decorator").map((d) => d.text.slice(1, 81)) : [];
    const bases = definition.type === "class_definition" ? (definition.childForFieldName("superclasses")?.text ?? "") : "";
    const attrs = definition.type === "class_definition"
      ? [...definition.text.matchAll(/^\s+(permission_classes|authentication_classes)\s*=\s*([^\n]+)/gm)].map((m) => `${m[1]} = ${m[2]!.slice(0, 80)}`)
      : [];
    const guards = [...decorators, ...(/Mixin/.test(bases) ? [bases.slice(0, 80)] : []), ...attrs];
    api.views.set(name, { guards, body: definition.text.slice(0, 4000) });
  }
}

// settings.py: REST_FRAMEWORK = { "DEFAULT_PERMISSION_CLASSES": [...IsAuthenticated] }
function defaultPermissions(root: Node, api: FileApi): void {
  const m = /["']DEFAULT_PERMISSION_CLASSES["']\s*:\s*[\[(]([^\])]*)/.exec(root.text);
  if (m) api.globalGuards.push(...m[1]!.split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean));
}

// urlpatterns = [...] + static(settings.MEDIA_URL, ...): the lists in it.
const listsIn = (node: Node): Node[] =>
  node.type === "list" ? [node] : node.type === "binary_operator" ? node.namedChildren.flatMap(listsIn) : [];

// urlpatterns = [...] and router = DefaultRouter()
function assignment(node: Node, api: FileApi, namespace: string | undefined): void {
  const left = node.childForFieldName("left")?.text;
  const right = node.childForFieldName("right");
  const lists = left === PATTERN && right ? listsIn(right) : [];
  if (lists.length) {
    // Never mounted: it's the root URLconf. Mounted: include() sets its prefix.
    api.routers.set(PATTERN, { prefix: "", isApp: true, ...(namespace ? { namespace } : {}) });
    for (const entry of lists.flatMap((l) => l.namedChildren)) if (entry.type === "call") patternEntry(entry, api);
  }
  const callee = right?.type === "call" ? right.childForFieldName("function")?.text.split(".").at(-1) : undefined;
  // include(router.urls) adds no namespace: the urls.py's app_name already covers its routes.
  if (left && callee && DRF_ROUTER.test(callee)) api.routers.set(left, { prefix: "", isApp: false });
}

// router.register(r"articles", ArticleViewSet): a list route and a detail route, named
// "<basename>-list" and "<basename>-detail". Without basename=, DRF takes the queryset's model
// name; the viewset's name without "ViewSet" is the usual match.
function register(call: Node, api: FileApi): void {
  const fn = call.childForFieldName("function");
  const router = fn?.type === "attribute" ? fn.childForFieldName("object")?.text : undefined;
  const prefix = text(argsOf(call)[0]);
  if (!router || fn?.childForFieldName("attribute")?.text !== "register" || !api.routers.has(router) || prefix === undefined) return;
  const line = call.startPosition.row + 1;
  const base = regexToPath(prefix) ?? prefix;
  const handler = viewName(argsOf(call)[1]);
  const basename = text(keywordValue(call, "basename")) ?? text(argsOf(call)[2]) ?? handler.replace(/(ViewSet|Viewset|View)$/, "").toLowerCase();
  api.routes.push(
    { method: "ALL", path: base, router, line, guards: [], handler, name: `${basename}-list` },
    { method: "ALL", path: `${base}/:pk`, router, line, guards: [], handler, name: `${basename}-detail` },
  );
}

export function djangoRoutes(root: Node, api: FileApi): void {
  views(root, api);
  defaultPermissions(root, api);
  const namespace = appName(root);
  for (const node of descendants(root)) {
    if (node.type === "assignment" || node.type === "augmented_assignment") assignment(node, api, namespace);
    else if (node.type === "call") register(node, api);
  }
}
