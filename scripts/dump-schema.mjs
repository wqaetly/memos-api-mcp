// Dump tools/list output to verify each tool's inputSchema has descriptions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: { ...process.env, MEMOS_API_KEY: "dummy", MEMOS_USER_ID: "dummy" }
});
const client = new Client({ name: "schema-dump", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
for (const t of tools) {
  console.log("=".repeat(80));
  console.log(`TOOL: ${t.name}`);
  console.log(`DESC: ${(t.description || "<NONE>").split("\n")[0]}`);
  const props = t.inputSchema?.properties || {};
  const required = new Set(t.inputSchema?.required || []);
  for (const [k, v] of Object.entries(props)) {
    const req = required.has(k) ? "REQ" : "opt";
    const desc = v.description || "<NO DESCRIPTION>";
    const type = v.type || (v.anyOf ? "union" : v.enum ? "enum" : "?");
    console.log(`  [${req}] ${k} :: ${type} -- ${desc.slice(0, 140)}`);
  }
}
await client.close();
