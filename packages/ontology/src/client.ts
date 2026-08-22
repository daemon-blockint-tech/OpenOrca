// TypeDB v3 HTTP v1 client. Verified live against a real server 2026-08-22 — see SPEC.md §B B5/B6.
// V2: never return a truncated (206 / warning) result silently.
// V3: on AUT3 (invalid/expired token, HTTP 401), re-signin once and retry once — no loop.

export type TransactionType = "read" | "write" | "schema";

export interface OntologyClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  databaseName: string;
}

export interface QueryAnswerResponse {
  queryType: "read" | "write" | "schema";
  answerType: "ok" | "conceptRows" | "conceptDocuments";
  answers: unknown;
  warning?: string | null;
}

export class OntologyTruncatedResultError extends Error {
  constructor() {
    super(
      "ontology_query: hasil terpotong di 10k — tulis ulang query dgn reduce/limit/offset",
    );
    this.name = "OntologyTruncatedResultError";
  }
}

export class OntologyQueryError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.code = code;
    this.name = "OntologyQueryError";
  }
}

export class OntologyClient {
  #config: OntologyClientConfig;
  #token: string | null = null;

  constructor(config: OntologyClientConfig) {
    this.#config = config;
  }

  async #signin(): Promise<string> {
    const res = await fetch(`${this.#config.baseUrl}/v1/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.#config.username,
        password: this.#config.password,
      }),
    });
    if (!res.ok) {
      throw new OntologyQueryError(
        undefined,
        `ontology signin failed: HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as { token: string };
    this.#token = data.token;
    return data.token;
  }

  async #ensureToken(): Promise<string> {
    return this.#token ?? this.#signin();
  }

  async #run(
    query: string,
    transactionType: TransactionType,
    attempt = 0,
  ): Promise<QueryAnswerResponse> {
    const token = await this.#ensureToken();

    const res = await fetch(`${this.#config.baseUrl}/v1/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        databaseName: this.#config.databaseName,
        transactionType,
        query,
        commit: transactionType !== "read",
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      warning?: string | null;
    } & Partial<QueryAnswerResponse>;

    // V3: re-signin once on an expired/invalid token, then retry once. A second failure
    // surfaces — never loop.
    if (body.code === "AUT3" && attempt === 0) {
      this.#token = null;
      await this.#signin();
      return this.#run(query, transactionType, attempt + 1);
    }

    if (!res.ok) {
      throw new OntologyQueryError(
        body.code,
        `ontology ${transactionType} query failed: ${body.code ?? res.status} ${body.message ?? ""}`.trim(),
      );
    }

    // V2: 206 (row cap hit) or an inline warning both mean the result is a truncated
    // subset — surface that explicitly rather than let the caller silently act on partial data.
    if (res.status === 206 || body.warning) {
      throw new OntologyTruncatedResultError();
    }

    return body as QueryAnswerResponse;
  }

  /** Read-only TypeQL pipeline (match/fetch/reduce). */
  query(query: string): Promise<QueryAnswerResponse> {
    return this.#run(query, "read");
  }

  /** Write TypeQL pipeline (insert/update/delete/put) — auto-commits. */
  write(query: string): Promise<QueryAnswerResponse> {
    return this.#run(query, "write");
  }

  /** Schema TypeQL (define/undefine/redefine) — auto-commits. */
  schema(query: string): Promise<QueryAnswerResponse> {
    return this.#run(query, "schema");
  }
}
