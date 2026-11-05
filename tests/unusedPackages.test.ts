import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRepo } from "./helpers.ts";
import { buildIndex } from "../src/index/repo.ts";
import { findUnusedPackages, packageOf } from "../src/rules/codebase/unusedPackages.ts";

const installed = (name: string, extra: object = {}) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, ...extra }),
});

test("packageOf: package names from import paths", () => {
  assert.equal(packageOf("react"), "react");
  assert.equal(packageOf("lodash/fp"), "lodash");
  assert.equal(packageOf("@react-three/drei/core"), "@react-three/drei");
  assert.equal(packageOf("./utils"), undefined);
  assert.equal(packageOf("node:fs"), undefined);
  assert.equal(packageOf("path"), undefined);
});

test("flags packages nothing uses, with their @types", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({
      dependencies: { react: "1", lodash: "1", "@types/lodash": "1" },
      devDependencies: { "left-pad": "1" },
    }),
    "src/app.ts": 'import React from "react";\n',
    ...installed("react"), ...installed("lodash"), ...installed("@types/lodash"), ...installed("left-pad"),
  });
  const found = await findUnusedPackages(await buildIndex(root));
  assert.deepEqual(found.map((p) => `${p.confidence} ${p.dev ? "dev " : ""}${p.name}`), [
    "sure lodash", "sure @types/lodash", "likely dev left-pad",
  ]);
  assert.ok(found[0]!.sizeBytes! > 0);
});

test("is only 'likely' when node_modules isn't installed", async () => {
  const root = await makeRepo({ "package.json": JSON.stringify({ dependencies: { lodash: "1" } }), "a.js": "" });
  assert.equal((await findUnusedPackages(await buildIndex(root)))[0]?.confidence, "likely");
});

test("does not flag packages used in other ways", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({
      scripts: { dev: "vite --open", lint: "eslint ." },
      dependencies: {
        react: "1", "@types/react": "1", "@types/node": "1", dotenv: "1",
        "ui-kit": "1", "styled-components": "1", "tree-sitter-python": "1",
      },
      devDependencies: { vite: "1", eslint: "1", "@babel/preset-env": "1", "eslint-plugin-react": "1" },
    }),
    "src/app.tsx": 'import React from "react";\nimport { Button } from "ui-kit";\n',
    "server.js": 'require("dotenv").config();\nconst W = { py: "tree-sitter-python/x.wasm" };\n',
    ".babelrc": '{ "presets": ["@babel/preset-env"] }',
    ".eslintrc.json": '{ "plugins": ["eslint-plugin-react"] }',
    ...installed("ui-kit", { peerDependencies: { "styled-components": "*" } }),
    ...installed("styled-components"), ...installed("react"), ...installed("dotenv"),
  });
  assert.deepEqual(await findUnusedPackages(await buildIndex(root)), []);
});

test("typescript is used wherever there's TypeScript, even with no tsc script", async () => {
  const pkg = JSON.stringify({ devDependencies: { typescript: "5.9.3" } });
  const withTs = await buildIndex(await makeRepo({ "package.json": pkg, "tsconfig.json": "{}", "src/a.astro": "---\n---\n" }));
  assert.deepEqual(await findUnusedPackages(withTs), []);
  const plainJs = await buildIndex(await makeRepo({ "package.json": pkg, "src/a.js": "export const a = 1;\n" }));
  assert.deepEqual((await findUnusedPackages(plainJs)).map((p) => p.name), ["typescript"]);
});

test("tools found by their config file, commands outside scripts, and framework peers count as used", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({
      dependencies: { remotion: "1", react: "1", "react-dom": "1", "@fontsource/inter": "1" },
      devDependencies: { prettier: "1", eslint: "1", "eslint-config-prettier": "1", prisma: "1", "ts-node": "1", stylelint: "1" },
      prisma: { seed: "ts-node seed.ts" },
    }),
    ".prettierrc": "{}\n",
    "eslint.config.mjs": "export default [];\n",
    "prisma/schema.prisma": "model User { id Int @id }\n",
    "src/Video.ts": 'import { AbsoluteFill } from "remotion";\nexport const V = AbsoluteFill;\n',
  });
  const found = await findUnusedPackages(await buildIndex(root));
  // No stylelint config, and the font is never loaded: both really unused.
  assert.deepEqual(found.map((p) => p.name), ["@fontsource/inter", "stylelint"]);
});

test("react counts as used with JSX, even with no import (the automatic runtime)", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({ dependencies: { react: "1", preact: "1" } }),
    "src/App.tsx": "export const App = () => <main />;\n",
  });
  assert.deepEqual((await findUnusedPackages(await buildIndex(root))).map((p) => p.name), ["preact"]);
});

test("without node_modules: commands named unlike their package, and react-email's peers", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({
      scripts: { dev: "email dev" },
      dependencies: { "react-email": "1", "react-dom": "1" },
      devDependencies: { "@react-email/ui": "1", "@types/react-dom": "1", "left-pad": "1" },
    }),
  });
  assert.deepEqual((await findUnusedPackages(await buildIndex(root))).map((p) => p.name), ["left-pad"]);
});
