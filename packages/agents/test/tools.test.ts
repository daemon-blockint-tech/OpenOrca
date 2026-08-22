import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeepAgent } from "deepagents";
import { OntologyClient } from "@openorca/ontology";
import { createOntologyTools } from "../src/tools/ontology.ts";

test("ontology_query/ontology_write register on createDeepAgent without TOOL_NAME_COLLISION (V9)", () => {
  const client = new OntologyClient({
    baseUrl: "http://localhost:8729",
    username: "admin",
    password: "password",
    databaseName: "openorca",
  });
  const { ontologyQuery, ontologyWrite } = createOntologyTools(client);

  assert.doesNotThrow(() => {
    createDeepAgent({ tools: [ontologyQuery, ontologyWrite] });
  });
});

test("tool names are exactly ontology_query and ontology_write", () => {
  const client = new OntologyClient({
    baseUrl: "http://localhost:8729",
    username: "admin",
    password: "password",
    databaseName: "openorca",
  });
  const { ontologyQuery, ontologyWrite } = createOntologyTools(client);
  assert.equal(ontologyQuery.name, "ontology_query");
  assert.equal(ontologyWrite.name, "ontology_write");
});
