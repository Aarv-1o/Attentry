import { readFileSync } from "node:fs";

const words = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(words.length);
