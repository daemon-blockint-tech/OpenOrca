// ontology_query / ontology_write — kontrak: context/kits/kit-agent-tools.md §ontology_query/§ontology_write.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { OntologyClient } from "@openorca/ontology";

/** Bind the two ontology tools to a concrete client (V9: names stay outside deepagents' builtins). */
export function createOntologyTools(client: OntologyClient) {
  const ontologyQuery = tool(
    async ({ query }: { query: string }) => {
      const result = await client.query(query);
      return JSON.stringify(result.answers);
    },
    {
      name: "ontology_query",
      description:
        "Run a read-only TypeQL query (match/fetch/reduce) against the OpenOrca context graph. " +
        "Throws if the result was truncated (>10k rows) — narrow the query with reduce/limit/offset instead of retrying blindly.",
      schema: z.object({
        query: z.string().describe("A TypeQL read pipeline, e.g. 'match $f isa finding, has id \"F-1\"; fetch { \"id\": $f.id };'"),
      }),
    },
  );

  const ontologyWrite = tool(
    async ({ query }: { query: string }) => {
      const result = await client.write(query);
      return JSON.stringify(result.answers);
    },
    {
      name: "ontology_write",
      description:
        "Run a write TypeQL pipeline (insert/update/delete/put) against the OpenOrca context graph, auto-committed. " +
        "For recording an agent action (audit trail — SPEC V7), insert through the concrete action subtype " +
        "(e.g. recall-action) with an explicit `links (subject: ...)` — see kit-ontology.md.",
      schema: z.object({
        query: z.string().describe("A TypeQL write pipeline, optionally preceded by a match clause."),
      }),
    },
  );

  return { ontologyQuery, ontologyWrite };
}
