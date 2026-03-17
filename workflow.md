# AI-Assisted Software Planning Workflow

This workflow transforms an idea — however rough — into a precise, machine-executable build plan. It forces clarity before a single line of code is written, so that when the Ralph Loop executes tasks, each agent has everything it needs to get the job done without ambiguity or mid-execution human intervention.

---

## How It Works

The workflow runs one initiative at a time. An initiative is whatever you decide to build right now — a new app, a new feature, a major capability. It can be small or large. Phase 2 helps you scope it appropriately.

Each initiative runs through seven phases: brain dump, grilling, codebase audit, technical proposal, final review, task generation, and execution. The output of each phase feeds the next. At the end, the Ralph Loop executes the generated tasks until the initiative is complete.

For larger products, the brain dump will naturally describe more than one initiative's worth of work. Phase 2 handles this by scoping the current initiative and capturing everything else as future initiatives in `initiatives.md`. Each future initiative gets its own full workflow run when its time comes — not pre-specified now.

**Prerequisites:** Phases 1–6 run in a conversational Claude session. Phase 7 (the Ralph Loop) requires [Bun](https://bun.sh) and Docker with the built-in `sandbox` command (`docker sandbox run claude <project-root>`), which mounts the project directory into an isolated container for each agent invocation.

---

## Files and Folders

**`initiatives.md`** — lives at the project root. Tracks all initiatives across the life of the product. Created or updated during Phase 2.

**`.planning/`** — all other workflow artifacts live here, scoped to the current initiative:

| Artifact | Created by | Purpose |
|---|---|---|
| `.planning/initial-thoughts.md` | Phase 1 | Structured brain dump |
| `.planning/behavioral-spec.json` | Phase 2 | BDD scenarios — source of truth for what to build |
| `.planning/codebase/` | Phase 3 | Codebase audit documents (existing projects only) |
| `.planning/technical-spec.json` | Phase 4 | Locked technical decisions |
| `.planning/tasks/manifest.json` | Phase 6 | Living execution record |
| `.planning/tasks/<id>.json` | Phase 6 | Self-contained task files |
| `.planning/agents/` | Included with workflow | Agent prompts used throughout the workflow |

When any artifact changes, all downstream artifacts must be updated before execution continues.

---

## Mid-Initiative Corrections

If a spec needs to change after Phase 5 — a failed task surfaces an ambiguity, a technical decision turns out to be wrong — correct it and work forward:

- **Behavioral change** → update `.planning/behavioral-spec.json`, check `.planning/technical-spec.json` for consistency, regenerate affected tasks.
- **Technical change** → update `.planning/technical-spec.json`, regenerate affected tasks.

Only regenerate the tasks affected by the change. Completed tasks are not touched. The engineer must approve changes before task regeneration proceeds.

**Skipping tasks:** If a task is no longer needed — requirements changed, the work was absorbed by another task, or it was generated in error — set its status to `"skipped"` in the manifest. Skipped tasks are treated as resolved for dependency purposes: downstream tasks will not be blocked by them. Do not mark skipped tasks as `"complete"` (dishonest) or `"failed"` (inaccurate), and do not delete them (breaks dependency chains).

---

## Phase 1: Brain Dump

The engineer dumps everything they know about what they want to build — as rough, vague, or incomplete as it actually is. Stream of consciousness, bullet points, a pasted document — whatever form it takes. The AI receives it without interruption, then organizes it into `.planning/initial-thoughts.md`. This is pure intake — the AI paraphrases and restructures for clarity but does not add substance, resolve ambiguities, or fill gaps. Probing for detail is Phase 2's job.

The output is a structured markdown document with four sections:

- **Capability Clusters** — the engineer's ideas reorganized around actor-goal pairs, with dependency annotations only when the engineer's own statements make a dependency evident.
- **Behavioral Seeds** — statements that hint at observable behavior (a trigger, a precondition, an outcome), each tagged by completeness: *near-complete* (close to a full Given/When/Then), *partial* (has a trigger but no outcome, or vice versa), or *implied* (suggests a branch of scenarios without describing any). Seeds are tagged, not fleshed out — missing pieces are not invented.
- **Gaps, Contradictions, and Assumptions** — gaps are behaviors implied by the engineer's own statements but not described (not things the AI thinks a complete system would need). Contradictions are two statements that imply different outcomes for the same situation. Assumptions are premises the engineer treated as settled that shape outcomes without having been examined. Each entry references the cluster(s) it relates to. All are flagged, none are resolved.
- **Parking Lot** — non-behavioral content quarantined so it doesn't leak into the behavioral investigation. Becomes relevant in later phases.

The engineer confirms the document before proceeding. If they add new material during confirmation, it is integrated into the existing structure — not appended to the end — and the document is re-presented.

**Output:** `.planning/initial-thoughts.md`

---

## Phase 2: Functional Grilling

This phase runs in two sequential modes. Mode 1 must be confirmed before Mode 2 begins.

**Mode 1 — Initiative Scoping**

The AI reads the brain dump and helps the engineer draw a boundary around the current initiative. If the brain dump describes more than one initiative's worth of work, Mode 1 identifies what belongs now and what is deferred. The AI proposes a boundary — erring toward smaller rather than larger — and the engineer confirms it. Everything deferred is captured in `initiatives.md` as a future initiative at rough-idea granularity.

If the brain dump fits naturally in a single initiative, Mode 1 simply confirms that and moves on.

**Mode 2 — Behavioral Grilling**

With the boundary confirmed, the AI interrogates the engineer to produce complete, unambiguous BDD scenarios covering every behavior within scope. BDD scenarios use Given/When/Then: the precondition, the trigger, the observable outcome. The AI drafts each scenario in real time and surfaces it for correction before moving on.

Every scenario must be concrete enough that a stateless agent could translate it into a failing test with no other context. Given describes a concrete, reproducible precondition. When describes a single, triggerable action. Then describes an observable, assertable outcome. "The user sees an error" is not a scenario — "The user sees a red banner with the text 'Email already registered'" is. Expect the AI to push for this level of specificity.

The interrogation is dynamic — answers surface new branches, which the AI traces to a leaf before closing. One focused question at a time. No implementation or architecture discussion.

The phase ends when the engineer explicitly confirms the scenario list is complete and accurate.

**Output:** `.planning/behavioral-spec.json` and an updated `initiatives.md`.

---

## Phase 3: Codebase Audit

Skipped for new projects with no existing code.

For existing projects, the AI spawns the **Codebase Auditor** agent (`.planning/agents/codebase-auditor.md`). The agent reads `.planning/behavioral-spec.json` first, then audits the codebase through that lens — asking what it needs to understand about the existing code to implement each scenario correctly. It produces eight files — seven focused documents covering stack, integrations, architecture, structure, conventions, testing, and known concerns, plus an `index.json` registry that the Task Generator uses to select which audit documents are relevant to each task.

Each audit starts blind — no assumptions carried forward from previous initiative runs. The agent never reads or quotes content from environment files, credentials, secrets, or key files — it notes their existence only.

**Output:** `.planning/codebase/`

---

## Phase 4: Technical Proposal

The AI reads the `.planning/behavioral-spec.json` and Codebase Audit, derives what decisions need to be made before any agent could implement the scenarios without guessing, and presents concrete recommendations to the engineer one decision area at a time.

The engineer reacts — approving, pushing back, or refining. The AI adjusts. This continues until all decisions are explicitly approved. The engineer never has to originate a technical decision from scratch — only react to proposals.

**Output:** `.planning/technical-spec.json`

---

## Phase 5: Final Review

_This is a conversational phase — it is handled by the system prompt agent (`system-prompt.md`), not a dedicated agent file._

The engineer reviews `.planning/behavioral-spec.json` and `.planning/technical-spec.json` side by side and confirms both accurately reflect their intent. This is the last checkpoint before tasks are generated. Changes here cascade forward — a behavioral change requires a consistency check on `.planning/technical-spec.json` and task regeneration; a technical change requires task regeneration.

No tasks are generated until the engineer explicitly approves both specs.

---

## Phase 6: Task Generation

The AI spawns the **Task Generator** agent (`.planning/agents/task-generator.md`) in a fresh context window with only the specs and Codebase Audit as input. The accumulated planning conversation is intentionally absent.

Each task the agent produces is a vertical slice — fully functional across every layer it touches, independently executable by a stateless agent with no knowledge of other tasks. Execution follows TDD: the executing agent writes tests first from the task's scenarios, confirms they fail, then implements the code to make them pass. Each task embeds everything unique to it directly: the relevant scenarios, the governing technical decisions, the implementation files to create or modify, and the pivotable assumptions that downstream tasks depend on. Shared codebase reference material is referenced by path — the executing agent reads audit documents directly from `.planning/codebase/` rather than receiving their content inline. Test files are not pre-declared — they are derived from scenarios at execution time.

Tasks with hard dependencies on each other are sequenced via `depends_on` — the loop will not start a task until all its dependencies are complete. Tasks with no dependencies can run in any order. The agent validates full scenario and decision coverage before finalizing output.

**Output:** `.planning/tasks/manifest.json` and one `.planning/tasks/<id>.json` per task.

---

## Phase 7: Execution (Ralph Loop)

```bash
bun ralph.ts
```

The Ralph Loop works through the task manifest one task at a time until all tasks are complete. A single task may take multiple loop iterations — the loop resumes an incomplete task automatically on the next iteration rather than advancing to a new one.

**Each iteration:**
1. Resume any `in_progress` task first; if none, retry the first `failed` task whose dependencies are all resolved; if none, pick the next `pending` task whose dependencies are all complete
2. Spawn the **Task Executor** agent (`.planning/agents/task-executor.md`) in a Docker sandbox (`docker sandbox run claude <project-root>`) with the task file and any prior progress context
3. Agent implements the task, writes a completion record to the manifest, emits a status signal
4. On `INCOMPLETE` or no signal — loop continues to next iteration on the same task
5. On `FAILED` — loop halts, surfaces the reason; resolve it and re-run
6. On `COMPLETE` — check for drift; if implementation deviated from the plan, spawn the **Drift Response** agent (`.planning/agents/drift-response.md`) to update affected pending tasks
7. Verify declared output files exist on disk
8. Commit all changes atomically
9. Advance to the next task

**Drift** is when an implementation deviates from what was planned. The Drift Response agent classifies the deviation, updates any pending tasks that were generated against stale assumptions, and flags the engineer if a locked technical decision was departed from — since that kind of change has implications beyond any individual task file.

**Failed tasks** require human resolution. Depending on the nature of the failure, this means correcting a spec (Mid-Initiative Corrections) or fixing the underlying issue the task surfaced. Re-run `bun ralph.ts` after resolving — the loop automatically retries failed tasks before starting new ones.
