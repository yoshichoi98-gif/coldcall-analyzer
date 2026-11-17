// One-off: add the call-review columns to the Notion "Cold Call Analysis" database.
//
// Notion rejects a page write that names a property the database does not have, so the columns
// have to exist before the first re-analysis write. Multi-select OPTIONS are created implicitly
// on write; the property itself is not. Run with: node scripts/add-review-properties.ts
//
// Reads NOTION_TOKEN and the database id from the local files the Worker uses, so there is no
// second copy of either to drift.

import fs from "node:fs";

const DB_ID = "00000000000000000000000000000052";

const token = fs
  .readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("NOTION_TOKEN="))
  ?.slice("NOTION_TOKEN=".length)
  .trim()
  .replace(/^["']|["']$/g, "");

if (!token) throw new Error("NOTION_TOKEN not found in .dev.vars");

const NEW_PROPERTIES = {
  "Call Score": { number: { format: "number" } },
  "Critical Mistakes": { number: { format: "number" } },
  Mistakes: { multi_select: {} },
  Strengths: { multi_select: {} },
  "Biggest Lever": { rich_text: {} },
};

async function notion(path, method, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

const before = await notion(`/databases/${DB_ID}`, "GET");
console.log("existing properties:", Object.keys(before.properties).sort().join(", "));

const missing = Object.fromEntries(
  Object.entries(NEW_PROPERTIES).filter(([name]) => !(name in before.properties)),
);
if (Object.keys(missing).length === 0) {
  console.log("nothing to add");
  process.exit(0);
}

console.log("adding:", Object.keys(missing).join(", "));
const after = await notion(`/databases/${DB_ID}`, "PATCH", { properties: missing });
console.log("now:", Object.keys(after.properties).sort().join(", "));
