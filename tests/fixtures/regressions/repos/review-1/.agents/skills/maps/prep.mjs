import { readFileSync } from "node:fs";

const geo = JSON.parse(readFileSync("in.json", "utf8"));
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
console.log(geo);
