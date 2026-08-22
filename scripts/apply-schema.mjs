#!/usr/bin/env node
// Apply context/kits/kit-ontology.md's schema + functions to the `openorca` TypeDB database.
// Idempotent: TypeDB's `define` is idempotent-or-error — re-running this against an
// already-applied, byte-identical schema is a safe no-op.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TYPEDB_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const TYPEDB_USER = process.env.TYPEDB_USER ?? "admin";
const TYPEDB_PASS = process.env.TYPEDB_PASS ?? "password";
const DB = process.env.TYPEDB_DB ?? "openorca";
const KIT_PATH = fileURLToPath(new URL("../context/kits/kit-ontology.md", import.meta.url));

async function signin() {
  const res = await fetch(`${TYPEDB_URL}/v1/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TYPEDB_USER, password: TYPEDB_PASS }),
  });
  if (!res.ok) throw new Error(`signin failed: HTTP ${res.status}`);
  const { token } = await res.json();
  return token;
}

async function ensureDatabase(token) {
  const check = await fetch(`${TYPEDB_URL}/v1/databases/${DB}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (check.status === 200) {
    console.log(`==> database "${DB}" already exists`);
    return;
  }
  const create = await fetch(`${TYPEDB_URL}/v1/databases/${DB}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!create.ok) throw new Error(`create database failed: HTTP ${create.status}`);
  console.log(`==> database "${DB}" created`);
}

async function applySchema(token, query, label) {
  const res = await fetch(`${TYPEDB_URL}/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ databaseName: DB, transactionType: "schema", query, commit: true }),
  });
  const body = await res.json();
  if (!res.ok) {
    // Idempotency: TypeDB's `define` is idempotent for TYPES (re-defining identical types is a
    // no-op) but NOT for FUNCTIONS — re-defining an existing `fun` throws FUN5 (SPEC §B B8).
    // Treat "already exists" as an idempotent no-op so a rerun against an applied schema succeeds.
    // NOTE: this tolerates a re-run, it does NOT pick up a CHANGED function body — in dev, TypeDB is
    // ephemeral (dev-down wipes it), so a schema change is picked up on the next fresh bootstrap.
    const alreadyExists =
      body.code === "FUN5" || /already exists|already defined/i.test(body.message ?? "");
    if (alreadyExists) {
      console.log(`==> ${label} already defined (idempotent no-op)`);
      return;
    }
    throw new Error(`${label} apply failed: ${body.code ?? res.status} ${body.message ?? ""}`);
  }
  console.log(`==> ${label} applied (${body.answerType})`);
}

function extractTypeqlBlocks(markdown) {
  const blocks = [...markdown.matchAll(/```typeql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (blocks.length < 2) {
    throw new Error(`expected at least 2 typeql blocks in kit-ontology.md, found ${blocks.length}`);
  }
  return blocks;
}

async function main() {
  const markdown = await readFile(KIT_PATH, "utf8");
  const [schemaBlock, functionsBlock] = extractTypeqlBlocks(markdown);

  const token = await signin();
  await ensureDatabase(token);
  await applySchema(token, schemaBlock, "schema (entities/relations)");
  await applySchema(token, functionsBlock, "functions (blast/owner-of/open-findings)");
  console.log("==> done");
}

main().catch((err) => {
  console.error("apply-schema failed:", err.message);
  process.exit(1);
});
