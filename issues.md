# Workflow Issues

Cross-referencing all seven files: `workflow.md`, `system-prompt.md`, `ralph.ts`, `codebase-auditor.md`, `task-generator.md`, `task-executor.md`, and `drift-response.md`.

Issues are grouped by severity.

---

## Critical

### 1. ralph.ts never sets task status to `"complete"` — potential infinite loop

When ralph.ts receives a `COMPLETE` signal, it verifies the completion record exists, handles drift, verifies output files, and commits — but it never explicitly sets `status: "complete"` on the task in the manifest. It relies entirely on the task executor having written that to the manifest from inside the Docker sandbox.

If the executor emits `<status>COMPLETE</status>` but fails to write `"status": "complete"` to the manifest (e.g., it wrote the completion object but left status as `"in_progress"`), ralph will verify files, commit, then on the next loop iteration pick up the same task as `in_progress` and resume it. The resumption would see all files present, the executor would re-verify and emit COMPLETE again, and the cycle repeats indefinitely.

**Fix:** Add a defensive status update in ralph.ts after completion validation succeeds — something like `await updateTask(task.id, t => ({ ...t, status: "complete" }))`.

**Files:** `ralph.ts` (COMPLETE handler, around the file-verification and commit logic)

---

### 2. Drift response agent prompt describes interactive conversation, but it runs non-interactively

`drift-response.md` Step 4 describes a conversational flow for decision-level drift: "If the engineer confirms the Technical Spec should be updated..." and "If the engineer confirms it is a one-off deviation, add a note to each affected task file..." This reads as if the agent will have a back-and-forth dialogue with the engineer.

In reality, ralph.ts spawns it as a one-shot subprocess via `runClaude`. The agent can only output `<engineer_required>` or `<drift_resolved/>` — it can never reach the "if the engineer confirms" branches. The prompt could confuse the agent into waiting for input that will never arrive, or into making a choice on the engineer's behalf that it shouldn't.

**Fix:** Rewrite drift-response.md Step 4 to make clear that for decision drift, the agent should *always* output `<engineer_required>` with a detailed summary. The "if the engineer confirms" branches should be removed or moved to documentation describing what the engineer does after the loop halts.

**Files:** `drift-response.md` (Step 4)

---

### 3. Drift agent crash is silently treated as success

After spawning the drift response agent (line 472), ralph.ts checks for `<engineer_required>` in the output (line 475). If that tag is absent, execution continues — regardless of whether the agent output `<drift_resolved/>`, crashed, or produced nothing at all. A crashed drift agent that updated zero task files would be indistinguishable from a successful one. The loop would commit and advance to the next task with corrupted downstream task state.

**Fix:** Ralph should explicitly check for `<drift_resolved/>` as the success signal. If neither `<engineer_required>` nor `<drift_resolved/>` is present in the output, treat it as an error and halt.

**Files:** `ralph.ts` (drift handling block, lines ~475-489)

---

### 4. Docker sandbox file access is unspecified

The task executor is instructed to write completion and progress records to the manifest at `.planning/tasks/manifest.json`, and ralph.ts spawns the executor via `docker sandbox claude`. Whether the executor can actually write to the manifest depends on how `docker sandbox` mounts the project directory. Ralph.ts doesn't configure any volume mounts or working directory — it's an undocumented assumption that `docker sandbox` handles this.

If the sandbox doesn't mount the project directory writably, the executor's manifest writes would silently fail. Combined with issue #1, this means COMPLETE tasks would loop forever, and INCOMPLETE tasks would lose their progress notes.

**Fix:** Either document the `docker sandbox` mount behavior explicitly, or have ralph.ts pass mount flags. Alternatively, have ralph.ts handle all manifest writes itself based on the executor's signal output, removing the executor's need to write to the filesystem at all.

**Files:** `ralph.ts` (the `runClaude` function, line ~237), `task-executor.md` (Steps 5 and Outcome B)

---

## High

### 5. ralph.ts ignores the manifest's `file` field

The manifest schema includes a `file` field per task (e.g., `.planning/tasks/T01.json`), and the task-generator is told to populate it. But ralph.ts constructs the task file path by convention:

```typescript
const taskFile = join(TASKS_DIR, `${task.id}.json`);
```

The `file` field from the manifest is never read. If someone named a task file differently from `<id>.json`, or if the task-generator produced a path that didn't match this convention, ralph would fail to find the task file.

**Fix:** Either have ralph.ts use `task.file` instead of deriving the path, or remove the `file` field from the manifest schema and document that file names must match `<id>.json`.

**Files:** `ralph.ts` (line ~344), `task-generator.md` (manifest schema)

---

### 6. Task executor's `FAILED` signal reference has a malformed tag

In `task-executor.md`, the "Failed" section (line 178) references the signal as:

> the same explanation as the `` `<status>FAILED: ...>` `` signal

This is missing the closing `</status>` portion. It should read `` `<status>FAILED: ...</status>` `` for consistency with the actual signal format shown in Outcome C (lines 131-133). Since the task executor is an LLM agent that pattern-matches on its own prompt, this malformed example could cause it to emit a tag that ralph's regex wouldn't parse correctly.

**Fix:** Change `<status>FAILED: ...>` to `<status>FAILED: ...</status>` in the Failed section.

**Files:** `task-executor.md` (line ~178)

---

### 7. `git add -A` in ralph.ts could stage unintended files

Line 524 uses `git add -A` which stages everything in the working tree, including files that might have been created outside the task — temp files, debug output, editor artifacts, `.env` files, or other sensitive material. The codebase-auditor agent is careful about identifying secrets and sensitive files, but the commit step has no filtering or gitignore verification.

**Fix:** Stage only the specific files listed in the task's `files` array and the manifest, or at minimum verify a `.gitignore` is in place before using `git add -A`.

**Files:** `ralph.ts` (line ~524)

---

## Medium

### 8. "Copied verbatim" doesn't mean verbatim

`task-generator.md` line 128 says decisions should be "the full text of every Technical Spec decision that governs this task's implementation, copied verbatim." But the task file schema only includes three fields — `area`, `decision`, and `rationale` — while the Technical Spec schema has five fields (`area`, `decision`, `rationale`, `alternatives_considered`, `affected_scenarios`).

"Copied verbatim" is misleading when it means "copy these three specific fields." This could confuse the task-generator agent into either including all five fields (bloating task files and potentially causing schema validation issues) or second-guessing which fields to include.

**Fix:** Change "copied verbatim" to something like "copied with the following fields: `area`, `decision`, and `rationale`" or explicitly state that `alternatives_considered` and `affected_scenarios` should be omitted from task files.

**Files:** `task-generator.md` (line ~128)

---

### 9. Drift log schema includes `"none"` as a valid drift type, but that can never occur

`drift-response.md` line 85 lists the drift_log schema with:

```json
"drift_type": "structural | decision | additive | local | none"
```

But the drift response agent is only invoked when `matched_plan: false` (ralph.ts line 448), and `drift_type: "none"` always corresponds to `matched_plan: true` (task-executor.md line 93). The agent would never encounter `none`. Including it in the schema could lead to the agent incorrectly logging `none` in ambiguous edge cases.

**Fix:** Remove `none` from the drift_log drift_type enum in drift-response.md.

**Files:** `drift-response.md` (line ~85)

---

### 10. Local drift spawns the drift response agent unnecessarily

When `drift_type` is `"local"`, the task executor sets `matched_plan: false`, which causes ralph.ts to spawn the full drift response agent. But `drift-response.md` Step 1 says for local drift: "Write a `drift_log` entry recording this and exit. No task files need updating."

An entire agent invocation — with Docker sandbox overhead — happens just to append one log entry. Ralph could handle local drift directly: check the drift_type, write the log entry, and skip the agent spawn entirely. This would save meaningful time per local-drift task.

**Fix:** Add a check in ralph.ts before spawning the drift agent: if `drift_type === "local"`, write the drift_log entry directly and skip the agent.

**Files:** `ralph.ts` (drift handling block, lines ~448-489)

---

### 11. workflow.md describes task resumption order ambiguously

workflow.md Phase 7 step 1 says: "Resume any `in_progress` task, retry any `failed` task, or pick the next `pending` task." This reads as if all three happen simultaneously or in arbitrary order.

ralph.ts implements a specific priority: `in_progress` first, then `failed`, then `pending`. The workflow description should match this priority ordering explicitly since it matters — a failed task should be retried before advancing to new pending tasks, and an in_progress task should be resumed before retrying a failed one.

**Fix:** Reword to: "Resume any `in_progress` task first; if none, retry the first `failed` task; if none, pick the next `pending` task by dependency order."

**Files:** `workflow.md` (Phase 7, step 1)

---

### 12. Task executor resumption logic doesn't account for the executor having written the completion record but not emitted the signal

`task-executor.md` Resumption section describes three states: no test files exist, test files exist but failing, test files exist and passing. But there's a fourth state: the previous iteration finished everything, wrote the completion record to the manifest, but the process was killed before emitting the `<status>` signal.

In this case, the manifest already has `status: "complete"` and the completion record. But ralph never saw the signal, so it treats the task as still in-progress and respawns the executor. The executor's resumption logic would see all tests passing and re-emit COMPLETE, which is benign — but it duplicates work. More critically, if the executor also tries to re-write the completion record, it could overwrite valid data.

**Fix:** Add a fourth resumption case: "Completion record already exists in manifest with `status: complete` — verify everything is in order and re-emit COMPLETE without modifying the manifest."

**Files:** `task-executor.md` (Resumption section)

---

### 13. No validation that the task-generator's dependency graph is a DAG

`task-generator.md` specifies that tasks have a `depends_on` array, and ralph.ts resolves dependencies to determine task ordering (line 384: `allDependenciesMet`). But neither the task-generator prompt nor ralph.ts validates that the dependency graph is acyclic.

A circular dependency (T01 depends on T02, T02 depends on T01) would cause ralph.ts to loop forever — no task would ever have all dependencies met, so `pickNextTask` would always return `undefined`, hitting the "All tasks complete!" exit condition only if the tasks are all marked complete, which they can't be.

Actually, ralph.ts would hit the `!task` branch (line 361) and exit with "All tasks complete!" even though tasks are still pending — a silent failure that falsely reports success.

**Fix:** Add a cycle-detection check in ralph.ts after reading the manifest, or instruct the task-generator to validate acyclicity.

**Files:** `ralph.ts` (after manifest read), `task-generator.md` (validation rules)

---

## Low

### 14. system-prompt.md and workflow.md use different shorthand for file paths

system-prompt.md consistently uses full paths like `.planning/behavioral-spec.json`, but in the "Mid-Initiative Corrections" sections, both workflow.md and system-prompt.md sometimes drop the `.planning/` prefix (e.g., "update `behavioral-spec.json`" instead of "update `.planning/behavioral-spec.json`"). This inconsistency is cosmetic but could confuse an LLM agent about where files actually live.

**Files:** `workflow.md` (Mid-Initiative Corrections), `system-prompt.md` (Mid-Initiative Corrections)

---

### 15. Manifest `progress` field structure is only defined in ralph.ts, not in any agent prompt

The `ManifestTask` interface in ralph.ts defines `progress` as an array of objects with `iteration`, `completed_files`, `remaining_files`, and `notes`. But the task-executor.md only shows a single progress object to "append to the task's progress array" — it doesn't describe the array structure or mention that multiple progress entries can accumulate. The task-generator.md manifest schema doesn't mention `progress` at all.

If the executor appends correctly, this works. But the executor has no schema definition for the array itself, only for a single entry. An LLM agent could plausibly overwrite the array instead of appending to it.

**Files:** `task-executor.md` (Outcome B), `task-generator.md` (manifest schema)

---

### 16. Codebase auditor's CONCERNS.md could overlap with Technical Spec's `open_risks`

The codebase auditor produces `CONCERNS.md` documenting "anything that could affect the project: fragile areas, migration risks, deprecated patterns, known bugs." The Technical Spec (system-prompt.md Phase 4) also has an `open_risks` array. There's no guidance on how these relate — whether `open_risks` should reference CONCERNS.md, subsume it, or be independent. This could lead to duplicated or contradictory risk tracking.

**Files:** `codebase-auditor.md` (CONCERNS.md section), `system-prompt.md` (Technical Spec schema)

---

### 17. workflow.md Phase 5 "Final Review" is described but has no corresponding agent file

Phases 1-2 are handled by system-prompt.md (the conversational agent). Phase 3 has codebase-auditor.md. Phase 6 has task-generator.md. Phase 7 has task-executor.md and drift-response.md. But Phase 5 (Final Review) is described in workflow.md as a distinct step where "you present the full plan for the engineer to review" — yet it's handled inline by the system-prompt.md agent, not by a dedicated agent.

This isn't wrong — it's a conversational phase — but it breaks the pattern of one-phase-one-agent that the other phases follow. Could cause confusion about where the Phase 5 logic lives.

**Files:** `workflow.md` (Phase 5)

---

### 18. `docker sandbox claude` command syntax is undocumented

ralph.ts line 237 uses:

```
docker sandbox claude --dangerously-skip-permissions --append-system-prompt-file ${agentFile} -p ${prompt}
```

The `docker sandbox` subcommand isn't a standard Docker CLI command. This appears to be a custom tool or wrapper, but its behavior — particularly around file system mounts, network access, and environment variables — is never documented in any of the workflow files. Anyone trying to use this workflow would need to know what `docker sandbox` is and how it works.

**Files:** `ralph.ts` (line ~237), `workflow.md` (could mention prerequisites)

---

### 19. Task executor says "Your task is in this prompt" but the task is injected by ralph.ts

`task-executor.md` Step 1 says "Your task is in this prompt." But the executor's prompt is a combination of the agent file (appended via `--append-system-prompt-file`) and the dynamic prompt built by ralph.ts (passed via `-p`). The task content comes from the `-p` prompt, not the system prompt file.

This is technically accurate — both are "in the prompt" — but the phrasing could mislead the agent into looking for task details in the system prompt file rather than in the user prompt. It's a minor clarity issue.

**Files:** `task-executor.md` (Step 1)

---

### 20. No mechanism to skip a task

The workflow defines four statuses: `pending`, `in_progress`, `complete`, `failed`. There's no `skipped` status. If the engineer decides a task is no longer needed (e.g., requirements changed mid-execution), the only options are to manually edit the manifest to mark it `complete` (dishonest) or `failed` (inaccurate), or to delete it (which could break dependency chains). A `skipped` status would let the engineer remove tasks cleanly without lying about the outcome.

**Files:** `ralph.ts` (TaskStatus type), `workflow.md` (could document this gap), `task-executor.md`
