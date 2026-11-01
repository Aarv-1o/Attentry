// A small repo for agent tool tests: one helper, used once, and a main file importing what
// the tests write.

const TIME_AGO = `export function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  return Math.floor(seconds / 3600) + "h ago";
}
`;
export const COPY = TIME_AGO.replace("timeAgo(date)", "commentAge(when)").replaceAll("date)", "when)");
export const REPO = {
  "src/utils/time.js": TIME_AGO,
  // Imports what the tests write, so its problems count (a file nothing uses is the finding itself).
  "src/main.js": 'import { timeAgo } from "./utils/time.js";\nimport { load } from "./api.js";\nimport { save } from "./save.js";\nexport const label = (d) => [timeAgo(d), load, save];\n',
};
