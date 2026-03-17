#!/usr/bin/env bun

// ─────────────────────────────────────────────
// Ralph Loop
// Executes tasks from .planning/tasks/manifest.json
// one at a time until all are complete.
//
// A task takes as many iterations as it needs.
// Each iteration resumes where the last left off.
//
// Run: bun ralph.ts
// ─────────────────────────────────────────────

import { $ } from "bun";
import { join, resolve } from "path";
import {
  validateManifest,
  validateTaskFile,
  type Manifest,
  type ManifestTask,
  type TaskFile,
  type ValidationResult,
} from "./schemas";

// Resolve the project root once at startup so all paths are absolute
// and the Docker sandbox can be given an explicit workspace mount.
const PROJECT_ROOT = resolve(".");
const MANIFEST_PATH = join(PROJECT_ROOT, ".planning/tasks/manifest.json");
const TASKS_DIR = join(PROJECT_ROOT, ".planning/tasks");
const AGENTS_DIR = join(PROJECT_ROOT, ".planning/agents");

// ─── Schema validation helpers ───────────────

function requireValid(result: ValidationResult): void {
  if (!result.ok) {
    console.error(`\nSchema validation failed: ${result.path}`);
    for (const e of result.errors) {
      console.error(e);
    }
    console.error("\nFix the schema errors before continuing.");
    process.exit(1);
  }
}

// ─── Manifest helpers ─────────────────────────

async function readManifest(): Promise<Manifest> {
  const data = await Bun.file(MANIFEST_PATH).json();
  requireValid(validateManifest(data));
  return data as Manifest;
}

async function readTaskFile(path: string): Promise<TaskFile> {
  const data = await Bun.file(path).json();
  requireValid(validateTaskFile(data, path));
  return data as TaskFile;
}

async function writeManifest(manifest: Manifest): Promise<void> {
  requireValid(validateManifest(manifest));
  await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function inProgressTask(manifest: Manifest): ManifestTask | undefined {
  return manifest.tasks.find((t) => t.status === "in_progress");
}

// IDs of tasks that count as resolved for dependency purposes.
function resolvedIds(manifest: Manifest): Set<string> {
  return new Set(
    manifest.tasks
      .filter((t) => t.status === "complete" || t.status === "skipped")
      .map((t) => t.id)
  );
}

function nextFailedTask(manifest: Manifest): ManifestTask | undefined {
  const resolved = resolvedIds(manifest);
  return manifest.tasks.find(
    (t) =>
      t.status === "failed" &&
      t.depends_on.every((dep) => resolved.has(dep))
  );
}

function nextPendingTask(manifest: Manifest): ManifestTask | undefined {
  const resolved = resolvedIds(manifest);
  return manifest.tasks.find(
    (t) =>
      t.status === "pending" &&
      t.depends_on.every((dep) => resolved.has(dep))
  );
}

function allComplete(manifest: Manifest): boolean {
  return manifest.tasks.every(
    (t) => t.status === "complete" || t.status === "skipped"
  );
}

async function updateTask(
  taskId: string,
  updater: (task: ManifestTask) => ManifestTask
): Promise<void> {
  const manifest = await readManifest();
  const idx = manifest.tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1) {
    manifest.tasks[idx] = updater(manifest.tasks[idx]);
  }
  await writeManifest(manifest);
}

// ─── Progress context ─────────────────────────
//
// Resumption context is derived from two sources, in priority order:
//
// 1. Filesystem — which declared files actually exist on disk.
//    This is ground truth regardless of what the agent managed to record.
//    An agent that ran out of context mid-execution writes nothing, but
//    the files it completed are still on disk.
//
// 2. Agent-written progress record — used for the human-readable "notes"
//    field only. Tells the resuming agent where things stood narratively.
//    Absent if the previous agent was killed before it could write.

async function buildProgressContext(
  task: ManifestTask,
  taskData: TaskFile
): Promise<string> {
  const nonDeleteFiles = taskData.files
    .filter((f) => f.action !== "delete")
    .map((f) => f.path);

  if (nonDeleteFiles.length === 0) return "";

  // Check filesystem — this is the authoritative source of what's done
  const presentFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const filepath of nonDeleteFiles) {
    if (await Bun.file(join(PROJECT_ROOT, filepath)).exists()) {
      presentFiles.push(filepath);
    } else {
      missingFiles.push(filepath);
    }
  }

  // If nothing has been written yet and no progress records exist,
  // this is a fresh start — no resumption context needed
  const hasProgress = task.progress && task.progress.length > 0;
  if (presentFiles.length === 0 && !hasProgress) return "";

  const iterationCount = task.progress?.length ?? 0;

  // Pull the last agent-written notes if they exist
  const lastNotes =
    task.progress && task.progress.length > 0
      ? task.progress[task.progress.length - 1].notes
      : null;

  const notesSection = lastNotes
    ? `**Where the last iteration left off (agent notes):**\n${lastNotes}`
    : "**Note:** The previous iteration did not leave notes. Use the file list above to orient yourself.";

  return `

---

## Resumption Context

This task has been attempted ${iterationCount} time(s) and is not yet complete. Do not start over.

**Files confirmed present on disk** (do not rewrite unless broken):
${presentFiles.length > 0 ? presentFiles.map((f) => `- ${f}`).join("\n") : "- None yet"}

${notesSection}

**Files still remaining:**
${missingFiles.length > 0 ? missingFiles.map((f) => `- ${f}`).join("\n") : "- None — all files are present. Verify correctness and emit COMPLETE if done."}

Pick up where the previous iteration left off. Check what is already on disk before writing anything.`;
}

// ─── Status signal parsing ────────────────────

type StatusSignal =
  | { type: "COMPLETE" }
  | { type: "INCOMPLETE" }
  | { type: "FAILED"; reason: string }
  | { type: "MISSING" };

function parseStatusSignal(output: string): StatusSignal {
  if (output.includes("<status>COMPLETE</status>")) return { type: "COMPLETE" };
  if (output.includes("<status>INCOMPLETE</status>"))
    return { type: "INCOMPLETE" };

  const failedMatch = output.match(/<status>FAILED:\s*(.*?)<\/status>/s);
  if (failedMatch) return { type: "FAILED", reason: failedMatch[1].trim() };

  return { type: "MISSING" };
}

// ─── Claude invocation ────────────────────────

async function runClaude(agentFile: string, prompt: string): Promise<string> {
  try {
    // Mount the project root explicitly so the agent has read-write access
    // to .planning/ regardless of what directory invoked `bun ralph.ts`.
    const result =
      await $`docker sandbox run claude ${PROJECT_ROOT} -- --dangerously-skip-permissions --append-system-prompt-file ${agentFile} -p ${prompt}`.text();
    return result;
  } catch (err) {
    // Non-zero exit — return whatever output was produced
    if (err instanceof Error && "stdout" in err) {
      return String((err as { stdout: unknown }).stdout ?? "");
    }
    return "";
  }
}

// ─── Display helpers ──────────────────────────

const DIVIDER = "\n" + "━".repeat(50);

function printDivider() {
  console.log(DIVIDER);
}

// ─── Preflight ────────────────────────────────

async function preflight(): Promise<void> {
  const checks = [
    { path: MANIFEST_PATH, label: "Manifest" },
    {
      path: join(AGENTS_DIR, "task-executor.md"),
      label: "Task executor agent",
    },
    {
      path: join(AGENTS_DIR, "drift-response.md"),
      label: "Drift response agent",
    },
  ];

  for (const { path, label } of checks) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.error(`ERROR: ${label} not found at ${path}`);
      if (path === MANIFEST_PATH) {
        console.error(
          "Complete Phase 6 (Task Generation) before running the Ralph Loop."
        );
      }
      process.exit(1);
    }
  }

  // Verify git is available and the project is a git repository.
  const gitCheck = await $`git rev-parse --is-inside-work-tree`.nothrow().quiet();
  if (gitCheck.exitCode !== 0) {
    console.error("ERROR: Not a git repository (or git is not installed).");
    console.error("Initialize a git repo (`git init`) before running the Ralph Loop.");
    process.exit(1);
  }

  // Validate manifest schema — readManifest() handles this now.
  // Calling it here so schema errors surface before the loop starts.
  const manifest = await readManifest();
  const tasks = manifest.tasks;
  const taskIds = new Set(tasks.map((t) => t.id));

  // Validate every task file referenced by the manifest.
  for (const t of tasks) {
    const taskFilePath = join(PROJECT_ROOT, t.file);
    const taskFileHandle = Bun.file(taskFilePath);
    if (await taskFileHandle.exists()) {
      try {
        const data = await taskFileHandle.json();
        const result = validateTaskFile(data, t.file);
        if (!result.ok) {
          console.error(`ERROR: Task file ${t.file} has schema errors:`);
          for (const e of result.errors) console.error(e);
          process.exit(1);
        }
      } catch {
        console.error(`ERROR: Task file ${t.file} contains invalid JSON.`);
        process.exit(1);
      }
    }
  }

  // Check for references to non-existent tasks while building adjacency.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!taskIds.has(dep)) {
        console.error(`ERROR: Task ${t.id} depends on ${dep}, which does not exist in the manifest.`);
        process.exit(1);
      }
    }
  }

  // Topological sort via Kahn's algorithm to detect cycles.
  const inDegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      inDegree.set(t.id, inDegree.get(t.id)! + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let sorted = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted++;
    // Find tasks that depend on `current` and decrement their in-degree.
    for (const t of tasks) {
      if (t.depends_on.includes(current)) {
        const newDeg = inDegree.get(t.id)! - 1;
        inDegree.set(t.id, newDeg);
        if (newDeg === 0) queue.push(t.id);
      }
    }
  }

  if (sorted !== tasks.length) {
    const stuck = tasks.filter((t) => inDegree.get(t.id)! > 0).map((t) => t.id);
    console.error(`ERROR: Dependency cycle detected involving: ${stuck.join(", ")}`);
    console.error("Fix the dependency graph in the manifest before running the loop.");
    process.exit(1);
  }

  console.log("  Preflight: manifest and all task files validated.");
}

// ─── Main Loop ────────────────────────────────

await preflight();

printDivider();
console.log("  Ralph Loop started");
console.log(`  Manifest: ${MANIFEST_PATH}`);
printDivider();

while (true) {
  // ── Check for unverified complete tasks ─────
  // If the agent wrote status: "complete" but the loop never ran file
  // verification or drift handling (e.g., the agent crashed after writing
  // the manifest but before emitting the signal), revert to in_progress
  // so the normal COMPLETE path runs on the next pick-up.

  {
    const checkManifest = await readManifest();
    const unverified = checkManifest.tasks.find(
      (t) => t.status === "complete" && t.completion != null && !t.loop_verified
    );
    if (unverified) {
      console.log(`\n⚠ Task ${unverified.id} is marked complete but was never verified. Re-entering COMPLETE path.`);
      await updateTask(unverified.id, (t) => ({ ...t, status: "in_progress" }));
    }
  }

  // ── Determine current task ──────────────────
  // Always resume an in_progress task before starting anything new.

  let manifest = await readManifest();
  let task = inProgressTask(manifest);
  let resuming = false;

  if (task) {
    resuming = true;
  } else {
    // Failed tasks take priority — they represent a previous iteration
    // the engineer has since resolved.
    task = nextFailedTask(manifest);

    if (task) {
      console.log(`\n↻ Retrying previously failed task: ${task.id} — ${task.title}`);
      await updateTask(task.id, (t) => ({
        ...t,
        status: "in_progress",
        failed_reason: null,
        completion: null,
      }));
      manifest = await readManifest();
      task = manifest.tasks.find((t) => t.id === task!.id)!;
      resuming = true;
    } else {
      task = nextPendingTask(manifest);

      if (!task) {
        if (allComplete(manifest)) {
          printDivider();
          console.log("  ✓ All tasks complete.");
          printDivider();
          process.exit(0);
        } else {
          printDivider();
          console.error("  ✗ No runnable tasks found and not all tasks are complete.");
          console.error("    Check for unresolved dependency cycles.");
          printDivider();
          process.exit(1);
        }
      }

      await updateTask(task.id, (t) => ({ ...t, status: "in_progress" }));
      manifest = await readManifest();
      task = manifest.tasks.find((t) => t.id === task!.id)!;
    }
  }

  const iteration = (task.progress?.length ?? 0) + 1;
  const taskFilePath = join(PROJECT_ROOT, task.file);

  if (!(await Bun.file(taskFilePath).exists())) {
    console.error(`ERROR: Task file not found: ${taskFilePath}`);
    process.exit(1);
  }

  // Read and validate the task file
  const taskData = await readTaskFile(taskFilePath);
  const taskFileContent = JSON.stringify(taskData, null, 2);

  printDivider();
  const resumeLabel = resuming ? `  (resuming, iteration ${iteration})` : `  (iteration ${iteration})`;
  console.log(`  Task: ${task.id} — ${task.title}${resumeLabel}`);
  printDivider();

  // ── Build prompt ────────────────────────────

  const executorAgentFile = join(AGENTS_DIR, "task-executor.md");
  const progressContext = await buildProgressContext(task, taskData);

  const prompt = `Your task file:

${taskFileContent}
${progressContext}

---

Manifest location for writing your progress or completion record: ${MANIFEST_PATH}
Current iteration number for progress records: ${iteration}
Schema validator — run after writing to the manifest or task file: bun schemas.ts manifest / bun schemas.ts task ${task.id}

Implement the task. If you complete it fully, write your completion record and emit <status>COMPLETE</status>.
If you have made progress but cannot finish in this iteration, write a progress record and emit <status>INCOMPLETE</status>.
If the task cannot be completed, write your completion record and emit <status>FAILED: reason</status>.`;

  // ── Execute ─────────────────────────────────

  console.log("\n▶ Executing...\n");
  const execResult = await runClaude(executorAgentFile, prompt);
  console.log(execResult);

  // ── Parse status signal ─────────────────────

  const signal = parseStatusSignal(execResult);

  // ── Handle missing signal ───────────────────
  // Agent crashed or was killed. Task stays in_progress.
  // Next iteration will resume it.

  if (signal.type === "MISSING") {
    printDivider();
    console.log("  ⚠  No status signal detected — treating as incomplete.");
    console.log("  The agent may have crashed or exhausted its context.");
    console.log("  The loop will resume this task on the next iteration.");
    printDivider();
    // Continue to next iteration — task is still in_progress
    continue;
  }

  // ── Handle INCOMPLETE ───────────────────────
  // Agent wrote a progress record. Loop continues to next iteration
  // on the same task. No exit.

  if (signal.type === "INCOMPLETE") {
    // Re-read manifest to validate whatever the agent wrote
    await readManifest();
    console.log(
      `\n↻ Iteration ${iteration} incomplete — resuming on next iteration.`
    );
    // Task remains in_progress. Continue the while loop.
    continue;
  }

  // ── Handle FAILED ───────────────────────────

  if (signal.type === "FAILED") {
    await updateTask(task.id, (t) => ({
      ...t,
      status: "failed",
      failed_reason: signal.reason,
    }));

    printDivider();
    console.log(`  ✗  Task ${task.id} failed`);
    console.log();
    console.log(`  ${signal.reason}`);
    console.log();
    console.log("  Resolve the failure then re-run the loop.");
    console.log("  See Phase 7 in the workflow for resolution guidance.");
    printDivider();
    process.exit(1);
  }

  // ── COMPLETE path ────────────────────────────

  // Re-read and validate manifest after agent execution
  const updatedManifest = await readManifest();
  const completedTask = updatedManifest.tasks.find((t) => t.id === task!.id)!;

  if (completedTask.completion == null) {
    printDivider();
    console.error(`  ✗ Task ${task.id} emitted COMPLETE but wrote no completion record.`);
    console.error("  Task remains in_progress. Next iteration will retry.");
    printDivider();
    continue;
  }

  // Re-read and validate the task file — the executor may have updated test_files
  const updatedTaskData = await readTaskFile(taskFilePath);

  // ── Verify declared files exist ──────────────
  // This must happen BEFORE setting status to "complete" — if files are
  // missing the task stays in_progress so the next iteration retries it.

  console.log("\nVerifying output files...");

  const implFiles = updatedTaskData.files
    .filter((f) => f.action !== "delete")
    .map((f) => f.path);

  const testFiles = updatedTaskData.test_files;

  let missing = 0;
  for (const filepath of [...implFiles, ...testFiles]) {
    if (await Bun.file(join(PROJECT_ROOT, filepath)).exists()) {
      console.log(`  ✓ ${filepath}`);
    } else {
      console.log(`  ✗ Missing: ${filepath}`);
      missing++;
    }
  }

  if (missing > 0) {
    printDivider();
    console.error(`  ✗ ${missing} declared file(s) not found after task execution.`);
    console.error("  Task remains in_progress. Next iteration will retry.");
    printDivider();
    continue;
  }

  // Defensive: ensure status is "complete" even if the executor only wrote
  // the completion record but failed to update the status field.
  if (completedTask.status !== "complete") {
    await updateTask(task.id, (t) => ({ ...t, status: "complete" }));
  }

  // ── Handle drift ────────────────────────────

  if (!completedTask.completion.matched_plan) {
    const driftType = completedTask.completion.drift_type;

    // Local drift means internals differed but the external surface matched.
    // No downstream tasks are affected — just log it and move on.
    if (driftType === "local") {
      console.log(`\n⚡ Drift detected (type: local) — no downstream impact, logging.\n`);
      const manifest = await readManifest();
      manifest.drift_log.push({
        triggered_by: task.id,
        drift_type: "local",
        tasks_updated: [],
        engineer_flagged: false,
        summary: completedTask.completion.summary,
      });
      await writeManifest(manifest);
    } else {
      // structural, decision, or additive — spawn the Drift Response agent.
      console.log(`\n⚡ Drift detected (type: ${driftType}) — running Drift Response agent...\n`);

      const driftAgentFile = join(AGENTS_DIR, "drift-response.md");
      const taskEntry = JSON.stringify(completedTask, null, 2);
      const fullManifest = await Bun.file(MANIFEST_PATH).text();

      const driftPrompt = `The task that just completed: ${task.id}

Completed task manifest entry:
${taskEntry}

Full manifest for scanning pending tasks:
${fullManifest}

Pending task files directory: ${TASKS_DIR}
Schema validator: bun schemas.ts manifest / bun schemas.ts task <ID> / bun schemas.ts task-all

Follow your instructions. Update affected pending task files. Append to the manifest drift_log.
After modifying any file, validate it: bun schemas.ts task <ID> and bun schemas.ts manifest.
If engineer input is required for decision-level drift, output:
<engineer_required>plain-language explanation of what needs a decision</engineer_required>
Otherwise output:
<drift_resolved/>`;

      const driftResult = await runClaude(driftAgentFile, driftPrompt);
      console.log(driftResult);

      const engineerMatch = driftResult.match(
        /<engineer_required>([\s\S]*?)<\/engineer_required>/
      );

      if (engineerMatch) {
        printDivider();
        console.log("  🛑 Engineer input required before execution can continue");
        console.log();
        console.log(engineerMatch[1].trim());
        console.log();
        console.log("  Resolve the decision, update the Technical Spec if needed,");
        console.log("  then re-run the loop.");
        printDivider();
        process.exit(1);
      }

      const resolved = /<drift_resolved\s*\/>/.test(driftResult);
      if (!resolved) {
        printDivider();
        console.error("  ✗ Drift Response agent produced no status signal.");
        console.error("  Expected <drift_resolved/> or <engineer_required>.");
        console.error("  Halting to avoid advancing with unresolved drift.");
        printDivider();
        process.exit(1);
      }

      // Post-drift validation: re-read manifest and all modified task files
      // to catch any schema violations the Drift Response agent introduced.
      const postDriftManifest = await readManifest();
      const pendingTasks = postDriftManifest.tasks.filter(
        (t) => t.status === "pending" || t.status === "in_progress"
      );
      for (const t of pendingTasks) {
        const path = join(PROJECT_ROOT, t.file);
        if (await Bun.file(path).exists()) {
          try {
            const data = await Bun.file(path).json();
            const result = validateTaskFile(data, t.file);
            if (!result.ok) {
              console.error(`\n⚠ Drift Response agent corrupted task file ${t.file}:`);
              for (const e of result.errors) console.error(e);
              console.error("Halting — fix the task file and re-run.");
              process.exit(1);
            }
          } catch {
            console.error(`\n⚠ Drift Response agent wrote invalid JSON to ${t.file}.`);
            console.error("Halting — fix the task file and re-run.");
            process.exit(1);
          }
        }
      }
    }
  }

  // ── Mark as verified ────────────────────────
  // The loop has confirmed files exist and handled drift. Mark the task
  // so the unverified-complete check at the top of the loop won't re-enter.
  await updateTask(task.id, (t) => ({ ...t, status: "complete", loop_verified: true }));

  // ── Commit ───────────────────────────────────

  console.log("\nCommitting...");

  try {
    // Stage only the files this task is responsible for:
    // 1. Declared implementation files from the task's files array
    // 2. Declared test files from the task's test_files array
    // 3. The .planning/ directory (manifest updates, drift log, task file edits)

    const allTaskFiles = [...implFiles, ...testFiles];

    if (allTaskFiles.length > 0) {
      const filesToStage = allTaskFiles
        .map((f) => $.escape(join(PROJECT_ROOT, f)))
        .join(" ");
      await $`git add ${{ raw: filesToStage }}`.quiet();
    }
    await $`git add ${join(PROJECT_ROOT, ".planning/")}`.quiet();

    const diffResult = await $`git diff --cached --quiet`.nothrow().quiet();

    if (diffResult.exitCode !== 0) {
      const commitType = updatedTaskData.commit_type ?? "feat";
      await $`git commit -m ${commitType + "(" + task.id + "): " + task.title}`;
    } else {
      console.log("  Nothing new to commit.");
    }
  } catch (err) {
    console.error("  Git commit failed:", err);
    process.exit(1);
  }

  // ── Done ─────────────────────────────────────

  console.log(`\n✓ ${task.id} complete after ${iteration} iteration(s).`);
}
