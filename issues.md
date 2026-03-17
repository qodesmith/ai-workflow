# Workflow Audit — Issues

## Bugs

### 1. ralph.ts skips post-completion checks when agent crashes after writing "complete"

If the task executor writes `status: "complete"` and the `completion` record to the manifest but then crashes (or runs out of context) before emitting `<status>COMPLETE</status>`, the loop sees a `MISSING` signal and `continue`s — leaving the task marked "complete" in the manifest. On the next iteration, no selector picks it up (`inProgressTask`, `nextFailedTask`, `nextPendingTask` all skip it). The task is treated as done without file verification or drift handling ever running.

The task-executor.md Resumption section anticipates this exact case and tells the agent to re-emit `COMPLETE` — but that only works if the task is picked up again, which it won't be since it's already marked "complete."

**Fix:** At the top of each loop iteration, check for tasks where `status === "complete"` but the loop hasn't yet verified files or handled drift (e.g., a `loop_verified` flag, or re-run the COMPLETE path for any task that's complete but wasn't processed in a prior iteration).

**Files:** `ralph.ts`, `task-executor.md`

---

### 2. `BrokenAssumption` type fields don't match what the task-executor prompt tells the agent to write

ralph.ts defines `{ assumption_id, assumption, reality }`. The task-executor.md tells the agent to copy the assumption's `id` and `description` — implying fields named `id` and `description`, not `assumption_id` and `assumption`. The executor never shows an explicit schema for broken assumptions (it only shows `broken_assumptions: []`), so the agent has to guess the field names. The drift-response agent reads these programmatically. This will cause silent mismatches.

**Fix:** Add an explicit broken assumption schema to the task-executor.md that matches the TypeScript type, or align the TypeScript type to what the prompt implies (`id`, `description`, `reality`).

**Files:** `ralph.ts`, `task-executor.md`

---

## Contradictions Between Files

### 3. Drift response agent's local drift instructions are dead code

drift-response.md Step 1 describes what to do for `local` drift: write a drift_log entry and emit `<drift_resolved/>`. But ralph.ts (lines 543–553) handles local drift inline without ever spawning the drift response agent — it writes the log entry directly and moves on. The agent will never be invoked for local drift. This isn't harmful but it's misleading: someone reading drift-response.md thinks the agent handles all four drift types, when in practice it only handles three.

**Files:** `drift-response.md`, `ralph.ts`

---

### 4. workflow.md Phase 7 omits dependency check for failed task retries

workflow.md says "retry the first `failed` task" but ralph.ts correctly checks that a failed task's dependencies are all resolved before retrying it. The workflow should mention this — otherwise an engineer reading only workflow.md might think failed tasks are retried unconditionally.

**Files:** `workflow.md`, `ralph.ts`

---

## Ambiguity / Unclear

### 6. Agent file locations are never explained

The workflow consistently references `.planning/agents/codebase-auditor.md`, `.planning/agents/task-executor.md`, etc. ralph.ts uses `const AGENTS_DIR = join(PROJECT_ROOT, ".planning/agents")`. But the files in this repo are at the root level (`codebase-auditor.md`, `task-executor.md`, etc.). workflow.md's files table says the `agents/` folder is "Included with workflow" — but there's no explanation of how these files get from wherever the user downloads them into `.planning/agents/`. A setup step or a note clarifying this would eliminate confusion.

**Files:** `workflow.md`, `ralph.ts`

---

### 7. "Docker with the built-in `sandbox` command" is misleading

workflow.md line 15: `docker sandbox` is not a standard Docker command — it's specific to the Claude tooling. Calling it "built-in" implies it ships with Docker, which is misleading.

**Fix:** Rephrase to something like "requires Docker and the `docker sandbox` CLI extension for Claude."

**Files:** `workflow.md`

---

### 8. Who writes progress entries — the loop or the agent?

task-generator.md (line 163) says "the loop accumulates an array of progress entries here." But it's actually the task executor agent that writes progress entries to the manifest (task-executor.md lines 113–128). The loop only reads them.

**Fix:** Change "the loop accumulates" to "the executing agent accumulates" or "the system accumulates."

**Files:** `task-generator.md`

---

### 9. No guidance on what happens to `.planning/` between initiatives

workflow.md says "one initiative at a time" and `initiatives.md` tracks current/future initiatives. But there's no guidance on what happens to `.planning/` artifacts from the previous initiative when starting a new one. Are they archived? Overwritten? Left in place?

**Files:** `workflow.md`, `system-prompt.md`

---

## Missing / Gaps

### 10. No git preflight check in ralph.ts

The commit step (lines 613–643) assumes a git repo exists. If someone runs `bun ralph.ts` in a project without `git init`, it'll fail at commit time with a confusing error. Adding a git check to `preflight()` would catch this early.

**Files:** `ralph.ts`

---

### 11. No explicit schema for broken assumption objects in task-executor.md

The completion record JSON examples show `broken_assumptions: []` but never show what an entry looks like. The agent has to infer the structure from prose ("find it by `id`, copy its `description`, and write what is actually true in `reality`"). This is where the mismatch in issue #2 originates. Adding a concrete JSON example to the executor prompt would prevent agents from guessing wrong.

**Files:** `task-executor.md`

---

### 12. ralph.ts `git add` stages entire parent directories

Lines 623–629 stage the parent directory of each declared file, which picks up test files (good) but could also pick up unrelated files that happen to live in the same directory.

**Fix:** Stage the specific declared files plus `*.test.*` / `*.spec.*` patterns in those directories instead.

**Files:** `ralph.ts`

---

## Minor / Stylistic

### 13. Inconsistent document count phrasing

workflow.md references "seven focused documents" and "plus an `index.json`" in the same sentence (line 97). Could be clearer: "eight files — seven focused documents plus an `index.json` registry." The codebase-auditor.md's completion section gets this right: "all eight files."

**Files:** `workflow.md`

---

### 14. `background` field in behavioral-spec.json is never explained to the task executor

The behavioral-spec.json schema includes `background` at the scenario level, but the task-executor.md process description never mentions it. Step 2 says "the Given clause sets up the precondition, the When clause triggers the behavior, the Then clause asserts the outcome" — no mention of `background`. The agent will see `background` in the scenario data but has no instruction on how to handle it.

**Files:** `task-executor.md`, `system-prompt.md`

---

### 15. Drift response Step 2 check is misplaced for structural drift

drift-response.md Step 2 for structural drift checks if "any embedded decision reference the departed Technical Spec decision." But structural drift isn't about decisions being departed from — that's decision drift. Structural drift is about the external surface changing. This check is slightly misplaced; it would make more sense under the decision drift section, or rephrased to focus on changed external surfaces.

**Files:** `drift-response.md`
