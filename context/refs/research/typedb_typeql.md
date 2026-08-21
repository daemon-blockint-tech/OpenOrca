## Layout

Query/reasoning-relevant crates (repo root = `typedb/typedb` v3, Rust workspace; one crate per top-level dir):

- **grammar (external)** — the TypeQL grammar is NOT in this repo. It's the `typeql` crate, a git dependency: `Cargo.lock` → `source = "git+https://github.com/typedb/typeql?tag=3.12.2"`. It provides the pest-based parser (`typeql::parse_query`, `typeql::parse_definition_function`, `typeql::parse_value`) and the AST (`typeql::query::QueryStructure`, `typeql::query::Pipeline`, `typeql::query::SchemaQuery`, `typeql::schema::definable::*`).
- `query/` — orchestration crate. `query/query_manager.rs` (`QueryManager`: parse → translate → annotate → compile → build executor), `query/define.rs` / `query/redefine.rs` / `query/undefine.rs` (schema query execution), `query/definable_resolution.rs` (label/type symbol resolution), `query/definable_status.rs` (idempotency checks for define), `query/query_cache.rs` (3-level moka cache), `query/analyse.rs` (`AnalysedQuery` for Studio/IDE introspection), `query/given_rows.rs` (external input rows).
- `ir/` — translation from TypeQL AST to internal IR. `ir/translation/` (`pipeline.rs`, `match_.rs`, `writes.rs`, `fetch.rs`, `function.rs`, `reduce.rs`, `modifiers.rs`, `expression.rs`, `literal.rs`, `tokens.rs`); `ir/pattern/` (`conjunction.rs`, `disjunction.rs`, `negation.rs`, `optional.rs`, `constraint.rs` — the `Constraint<ID>` enum: `Label`, `RoleName`, `Kind`, `Sub`, `Is`, `Isa`, `Iid`, `Has`, `Links`, `IndexedRelation`, `Comparison`, `FunctionCallBinding`, `ExpressionBinding`, `Owns`, `Relates`, `Plays`, `Value`); `ir/pipeline/` (`block.rs` `Block`, `function.rs` `Function`/`ReturnOperation`, `function_signature.rs` `FunctionID{Schema|Preamble}`, `fetch.rs` `FetchObject`/`FetchSome`, `reduce.rs` `Reducer`, `modifier.rs`, `VariableRegistry`, `ParameterRegistry`).
- `compiler/` — annotation (type inference) + executable compilation (planning). `compiler/annotation/` (`pipeline.rs` `annotate_preamble_and_pipeline` → `AnnotatedPipeline`/`AnnotatedStage`; `inference/type_seeder.rs` + `inference/match_inference.rs` — constraint-graph type inference; `write_type_check.rs`; `expression/`; `fetch.rs`; `function.rs`). `compiler/transformation/` (`transform.rs` `apply_transformations` — static optimizer passes). `compiler/executable/` (`pipeline.rs` `compile_pipeline_and_functions` → `ExecutablePipeline`; `match_/planner/plan.rs` — cost-based **beam-search planner** (`beam_search_plan`, statistics-driven); `match_/planner/conjunction_executable.rs` — `ConjunctionExecutable` with `ExecutionStep` {`IntersectionStep`, `UnsortedJoinStep`, `AssignmentStep`, `CheckStep`, `DisjunctionStep`, `NegationStep`, `OptionalStep`, `FunctionCallStep`}; `match_/instructions/{thing,type_}.rs` — `ConstraintInstruction<ID>` with forward/reverse variants (`Has`/`HasReverse`, `Links`/`LinksReverse`, `Isa`/`IsaReverse`, `Sub`, `Owns`, `Relates`, `Plays`, `Iid`, `TypeList`…); `insert/`, `delete/`, `update/`, `put/`, `reduce.rs`, `fetch/`, `function/` (incl. `recursion_analyser.rs`)).
- `executor/` — runtime. `executor/pipeline/` (one stage executor per pipeline operator: `match_.rs`, `insert.rs`, `update.rs`, `put.rs`, `delete.rs`, `fetch.rs`, `given.rs`, `modifiers.rs`, `reduce.rs`; `stage.rs` `StageAPI` trait + `ReadPipelineStage`/`WritePipelineStage` enums; `pipeline.rs` `Pipeline`); `executor/match_executor.rs` (`MatchExecutor`); `executor/read/` (`pattern_executor.rs` `PatternExecutor` — control-stack VM; `immediate_executor.rs` `IntersectionExecutor` — n-way sorted intersection; `tabled_functions.rs` + `tabled_call_executor.rs` + `suspension.rs` — recursion via tabling); `executor/instruction/` (one storage-iterator executor per constraint instruction: `has_executor.rs`, `links_executor.rs`, `isa_executor.rs`, `indexed_relation_executor.rs`, plus `*_reverse_executor.rs` twins); `executor/write/write_instruction.rs`; `executor/document.rs` (fetch documents); `executor/batch.rs` (`Batch`, `FixedBatch`).
- `function/` — schema-function lifecycle: `function/function_manager.rs` (`FunctionManager`: `define_functions`, `undefine_function`, `redefine_function`, `finalise` (commit-time re-typecheck), `validate_no_cycles` (stratification)), `function/function_cache.rs`.
- `answer/` — `answer/lib.rs` (`Concept`, `Type`, `Thing`), `answer/variable_value.rs` (`VariableValue`), `answer/variable.rs` (`Variable`).
- `server/` — network surface: `server/service/grpc/transaction_service.rs`, `server/service/http/transaction_service.rs`.
- Out of pipeline scope but referenced: `concept/` (TypeManager/ThingManager + `thing/statistics.rs` planner statistics), `database/` (`TransactionRead/Write/Schema` in `database/transaction.rs`), `storage/`, `encoding/`.

Tests with real TypeQL: `query/tests/{define,fetch,query_profile}.rs`, `executor/tests/{execute_function,pipelines,writes}.rs`, `ir/tests/binding_modes.rs`. BDD `.feature` files are external (`typedb_behaviour` bazel dep, drivers in `tests/behaviour/query/language/*.rs`).

## Core flow

Four phases, all visible in `query/query_manager.rs`:

1. **Parse** — `QueryManager::parse` (`query/query_manager.rs:82`) calls `typeql::parse_query(query)`; `QueryStructure::Schema(SchemaQuery)` routes to `execute_schema`, `QueryStructure::Pipeline` continues. Parse results cached by query string (`query/query_cache.rs` `parse_cache: Cache<String, Arc<Pipeline>>`).
2. **Translate (AST → IR)** — `translate_pipeline` (`query/query_manager.rs:469`) builds a `ReadThroughFunctionSignatureIndex` (preamble functions + stored schema functions) and calls `ir::translation::pipeline::translate_pipeline` → `TranslatedPipeline { translated_preamble: Vec<Function>, translated_given: Option<TranslatedGiven>, translated_stages: Vec<TranslatedStage>, translated_fetch: Option<FetchObject>, variable_registry, value_parameters }`. `TranslatedStage` (`ir/translation/pipeline.rs`): `Match|Insert|Update|Put|Delete` (each holding a `Block` of conjunction+nested patterns) plus operators `Select|Sort|Offset|Limit|Require|Reduce|Distinct`. Structural rules enforced here: `given` only as first stage (`RepresentationError::NonInitialGiven`), `fetch` only terminal (`NonTerminalFetch`), expressions in write stages rejected (`UnimplementedExpressionsInWrite`), stage count ≤ `MAX_PIPELINE_STAGES` (`resource/constants.rs`).
3. **Annotate + transform + compile** — `annotate_and_compile_query` (`query/query_manager.rs:492`):
   - `validate_no_cycles` (`function/function_manager.rs:391`) — **stratification** check: recursion is legal, but a cycle that passes through a negated call or an aggregating stage (`Sort|Distinct|Offset|Limit|Reduce`) or non-stream return raises `FunctionError::StratificationViolation`.
   - `annotate_preamble_and_pipeline` (`compiler/annotation/pipeline.rs:115`) — type inference. `compiler/annotation/inference/type_seeder.rs` seeds each IR vertex with candidate types from the schema (`TypeManager`), `match_inference.rs` runs graph propagation over `TypeInferenceEdge`s until fixpoint, producing `BlockAnnotations` (per-vertex `BTreeSet<answer::Type>`). Writes are type-checked in `compiler/annotation/write_type_check.rs` (`check_type_combinations_for_write`). Expressions compiled in `compiler/annotation/expression/`.
   - `apply_transformations` (`compiler/transformation/transform.rs:22`) — static optimizer: `optimize_away_statically_unsatisfiable_conjunctions`, `prune_redundant_roleplayer_deduplication`, `relation_index_transformation` (rewrites 2-role-player relations to use the relation index → `IndexedRelation` constraint), `make_constraint_variables_unique`.
   - `compile_pipeline_and_functions` (`compiler/executable/pipeline.rs:148`) — planning. Per match block: `compile` (`compiler/executable/match_/planner/mod.rs`) → `plan_conjunction` (`plan.rs:85`) runs a cost-based **beam search** (`beam_search_plan`, `plan.rs:614`; beam width `(num_patterns*2).clamp(2, MAX_BEAM_WIDTH)`, narrowing to greedy at the tail) with costs from `concept::thing::statistics::Statistics`. Output: `ConjunctionExecutable` — an ordered list of `ExecutionStep`s where each `IntersectionStep` carries a sort variable + a set of `ConstraintInstruction`s. Functions get compilation order + tabling assignment via `determine_compilation_order_and_tabling_types` (`compiler/executable/function/recursion_analyser.rs:22`): Kosaraju SCC over the call graph; cycle members become `FunctionTablingType::Tabled(StronglyConnectedComponentID)`, everything else `Untabled` (inlined). Result: `ExecutablePipeline { executable_functions: ExecutableFunctionRegistry, executable_stages: Vec<ExecutableStage>, executable_fetch, ... }` — cached in `executable_cache` keyed by **structural equality of the IR** (`StructuralEquality` impls throughout `ir/`), invalidated when `Statistics.sequence_number` moves (`QueryCache::set_statistics_and_invalidate_outdated`).
4. **Execute** — `Pipeline::build_read_pipeline` / `build_write_pipeline` (`executor/pipeline/pipeline.rs:99/248`) chain stage executors (`ReadPipelineStage`/`WritePipelineStage` enums, `executor/pipeline/stage.rs:160/275`); each implements `StageAPI::into_iterator(input, ExecutionContext, ExecutionInterrupt)`, pulling lazily from the previous stage (reads) or executing eagerly into a `Batch` (writes → `WrittenRowsIterator`). Match: `MatchExecutor` (`executor/match_executor.rs`) drives a `PatternExecutor` (`executor/read/pattern_executor.rs`) — a small VM with a `control_stack: Vec<ControlInstruction>` (`PatternStart`, `ExecuteImmediate`, `ExecuteDisjunctionBranch`, `ExecuteNegation`, `ExecuteOptional`, `ExecuteInlinedFunction`, `ExecuteTabledCall`, `RestoreSuspension`, `Yield`, …) producing `FixedBatch`es. The workhorse is `IntersectionExecutor` (`executor/read/immediate_executor.rs:172`): n-way intersection of sorted per-constraint storage iterators (`executor/instruction/*_executor.rs`, forward + reverse per constraint), with a cartesian sub-program for multi-value matches. **Recursive functions**: `TabledFunctions`/`TabledFunctionState` (`executor/read/tabled_functions.rs`) memoize answers per `CallKey` (function id + arguments); calls that hit an incomplete table **suspend** (`executor/read/suspension.rs` `QueryPatternSuspensions`) and are retried until fixpoint — tabled evaluation, so cyclic reachability terminates (see `executor/tests/execute_function.rs::quadratic_reachability_in_tree`).

**Schema queries** bypass all of that: `QueryManager::execute_schema` → `define::execute` (`query/define.rs:82`) applies definables in a fixed order — structs, then types (kind decl → alias → value type → type annotations → `sub` → `relates`+annotations → `relates ... as` specialise → `owns`+annotations → `plays`+annotations), then functions — calling `TypeManager` mutation APIs (`concept/type_/type_manager.rs`). `query/definable_status.rs` (`get_owns_status`, `get_sub_status`, …) makes `define` idempotent-or-error. Annotation tokens map in `ir/translation/tokens.rs::translate_annotation`: `@abstract`, `@card(n..m)`, `@cascade`, `@distinct`, `@independent`, `@key`, `@range(a..b)`, `@regex("..")`, `@unique`, `@values(..)`, `@doc`, `@meta`; `@subkey` returns `UnimplementedFeature::Subkey`. Functions are persisted as **unparsed TypeQL source** (`FunctionDefinition`, `function/function_manager.rs::define_functions` — stored under a `DefinitionKey` + `NameToFunctionDefinitionIndex`), re-translated and type-checked against the whole schema at commit (`FunctionManager::finalise`).

Concrete syntax (from in-repo tests):

```typeql
# schema — query/tests/fetch.rs, executor/tests/execute_function.rs
define
  attribute name value string;
  attribute age value integer;
  relation friendship relates friend @card(0..);
  entity person owns name @card(0..), owns age, plays friendship:friend @card(0..);

# write — query/tests/fetch.rs
insert
  $x isa person, has age 10, has name "Alice";
  (friend: $x, friend: $y) isa friendship;

# full pipeline w/ preamble function, negation, optional, disjunction — query/tests/query_profile.rs
with
fun get_age($p_arg: person) -> { age }:
match
    $p_arg has age $age_return;
return { $age_return };

match
    $x isa person, has name $name;
    let $age in get_age($x);
    { $age >= 12; } or { $age <= 10; };
    not { $x has name "Charlie"; };
    try { $x has nickname $nick; };
sort $name asc;
select $x, $name, $age;
offset 0;
limit 10;

# recursion (v2-rule replacement) — executor/tests/execute_function.rs
with
fun reachable($start: node) -> { node }:
match
    $end isa node;
    { edge (start: $start, end_: $middle); let $end in reachable($middle); } or
    { edge (start: $start, end_: $end); };
return { $end };
match
    $start isa node, has name "c1";
    let $to in reachable($start);

# reduce — executor/tests/execute_function.rs
reduce $age_sum = sum($age_return);   # Reducer: count|sum|max|min|mean|median|std, optional groupby (ir/pipeline/reduce.rs, ir/translation/reduce.rs)

# fetch (terminal, produces documents) — query/tests/fetch.rs
fetch {
  "single attr": $a,
  "single-card attributes": $x.age,
  "single value expression": $a + 1,
  "single answer block": ( match $x has name $name; return first $name; ),
  "reduce answer block": ( match $x has name $n; return count($n); ),
  "list pipeline": [ match $x has name $n; fetch { "name": $n }; ],
  "all attributes": { $x.* }
};
```

Pipeline stages available (exhaustive, from `ir/translation/pipeline.rs::translate_stage`): `given` (first-stage external row binding), `match`, `insert`, `update`, `put` (per-row match-else-insert — `executor/pipeline/put.rs::match_iterator_for_row`/`perform_inserts`), `delete`, `fetch` (terminal), and operators `select`, `sort`, `offset`, `limit`, `reduce` (+ `groupby`), `require`, `distinct`. Function return forms (`ir/pipeline/function.rs::ReturnOperation`): `Stream` (`return { $x }`), `Single` (`return first/last $x`), `ReduceReducer` (`return count($x)`), `ReduceCheck` (`return check`).

## Public API

- `query/query_manager.rs` — `QueryManager` (the crate boundary an embedder calls): `parse(&str) -> ParsedQuery`, `execute_schema(&mut WritableSnapshot, &TypeManager, &ThingManager, &FunctionManager, &SchemaQuery, &str)`, `prepare_read_pipeline(Arc<Snapshot>, …, &typeql::query::Pipeline, Option<impl GivenRows>, &str) -> Pipeline<Snapshot, ReadPipelineStage<Snapshot>>`, `prepare_write_pipeline(Snapshot, …) -> Pipeline<Snapshot, WritePipelineStage<Snapshot>>` (returns the snapshot back on error), `analyse(…) -> AnalysedQuery`.
- `executor/pipeline/pipeline.rs` — `Pipeline::into_rows_iterator(ExecutionInterrupt)` (row answers: `MaybeOwnedRow` of `answer::VariableValue`) and `Pipeline::into_documents_iterator` (fetch: `executor/document.rs` `ConceptDocument`); `has_fetch()`, `rows_positions()`.
- `function/function_manager.rs` — `FunctionManager::{define_functions, undefine_function, redefine_function, finalise, get_annotated_functions}`.
- Network callers (what an external program actually hits): gRPC `server/service/grpc/transaction_service.rs` (`blocking_read_query_worker` → `prepare_read_pipeline` → streams rows or documents per `pipeline.has_fetch()`; schema via `execute_schema_query`), HTTP mirror in `server/service/http/transaction_service.rs`. Protocol crate: `typedb_protocol` (external dep). Embedded-Rust surface: `database/transaction.rs` `TransactionRead/TransactionWrite/TransactionSchema` each carry `query_manager`, `type_manager`, `thing_manager`, `function_manager`, `snapshot` — the tests (`executor/tests/*.rs`, `query/tests/*.rs`) show the exact embedding recipe.

## Extension points

- **New constraint kind** end-to-end path: `ir/pattern/constraint.rs` (`Constraint<ID>` + `ConstraintsBuilder::add_*`) → translation in `ir/translation/constraints.rs` → type seeding in `compiler/annotation/inference/type_seeder.rs` → planner vertex `compiler/executable/match_/planner/vertex/constraint.rs` → instruction in `compiler/executable/match_/instructions/{thing,type_}.rs` → executor pair in `executor/instruction/<x>_executor.rs` + `<x>_reverse_executor.rs`, registered in `executor/instruction/iterator.rs`.
- **New pipeline stage**: `TypeQLStage` match in `ir/translation/pipeline.rs::translate_stage` → `TranslatedStage` → `AnnotatedStage` (`compiler/annotation/pipeline.rs`) → `ExecutableStage` (`compiler/executable/pipeline.rs`) → executor + `ReadPipelineStage`/`WritePipelineStage` variants (`executor/pipeline/stage.rs`).
- **New annotation**: `ir/translation/tokens.rs::translate_annotation` + `concept/type_/annotation.rs`; enforcement in `query/define.rs` + `TypeManager`.
- **Optimizer passes**: add to `compiler/transformation/transform.rs::apply_transformations` (the file's comment block lists planned passes: check-subtree extraction, constraint push-down into functions, function inlining v1/v2).
- **Reducers**: `ir/pipeline/reduce.rs::Reducer` + `compiler/executable/reduce.rs::ReduceInstruction` + `executor/reduce_executor.rs`.
- **Planner cost model**: `compiler/executable/match_/planner/vertex/mod.rs` (per-vertex cost from `Statistics`); function call costs stubbed behind `FunctionCallCostProvider` (`plan.rs:518` — "TODO: Use the real cost when we have function planning").

## Notes for integrators

- Grammar changes require the separate `typeql` repo; this repo consumes only its AST. Everything after `typeql::parse_query` is this repo.
- Reasoning in v3 = **functions**, not rules. There is no rule engine; v2 `rule ... when/then` is replaced by `fun` definitions (schema-level via `define fun`, query-level via `with fun ... match ...` preambles). Recursion is supported and evaluated with SCC-based tabling/memoization + suspension (terminates on cyclic data); stratified negation/aggregation is enforced at translation time (`FunctionError::StratificationViolation`).
- Caching is three-tier and statistics-versioned (`query/query_cache.rs`): parse (string-keyed), translation (string-keyed), executable (IR-structural-equality-keyed). Anything you change in IR must maintain the `StructuralEquality` impls or you'll silently miss/poison the plan cache; executables invalidate when `thing_manager.statistics().sequence_number` advances.
- Read pipelines are lazy pull-based batch iterators; write stages (`insert/update/put/delete`) execute **eagerly** when the pipeline is materialized into an iterator — a "prepared" write pipeline has not run until `into_rows_iterator`/`into_documents_iterator` is called.
- Type inference happens per-query against the live schema snapshot; a query that mentions an impossible type combination fails at annotation (`QueryError::Annotation`), not at execution — integrators should surface annotation errors as user-facing query errors, and `QueryManager::analyse` gives the full inferred-annotation structure without executing.
- Not-yet-implemented features you will hit: expressions in write stages (`RepresentationError::UnimplementedExpressionsInWrite`), `@subkey`, list attributes `$x.name[]` (commented out in `query/tests/fetch.rs`), `require` inside functions (`query/tests/unimplemented.rs`). Pipeline length capped by `MAX_PIPELINE_STAGES` (`resource/constants.rs`); query-structure output disabled beyond 64 branch ids (`query/query_manager.rs:262`).
- Deep recursion executes on the Rust stack: executor tests spawn 32MB-stack threads for recursive-function tests (`executor/tests/execute_function.rs`) — embedders running recursive queries on small stacks will overflow.
