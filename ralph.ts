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
import { join } from "path";

const MANIFEST_PATH = ".planning/tasks/manifest.json";
const TASKS_DIR = ".planning/tasks";
const AGENTS_DIR = ".planning/agents";

// ─── Types ────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "complete" | "failed";

interface ProgressEntry {
  iteration: number;
  completed_files: string[];
  remaining_files: string[];
  notes: string;
}

interface BrokenAssumption {
  assumption_id: string;
  assumption: string;
  reality: string;
}

interface CompletionRecord {
  summary: string;
  matched_plan: boolean;
  drift_type: "none" | "local" | "structural" | "decision" | "additive";
  broken_assumptions: BrokenAssumption[];
  notes: string | null;
}

interface ManifestTask {
  id: string;
  file: string;
  title: string;
  depends_on: string[];
  status: TaskStatus;
  failed_reason?: string | null;
  progress?: ProgressEntry[];
  completion?: CompletionRecord | null;
}

interface Manifest {
  tasks: ManifestTask[];
  drift_log: DriftLogEntry[];
}

// ─── Manifest helpers ─────────────────────────

async function readManifest(): Promise<Manifest> {
  return await Bun.file(MANIFEST_PATH).json();
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function allTasks(manifest: Manifest): ManifestTask[] {
  return manifest.tasks;
}

function inProgressTask(manifest: Manifest): ManifestTask | undefined {
  return allTasks(manifest).find((t) => t.status === "in_progress");
}

function nextPendingTask(manifest: Manifest): ManifestTask | undefined {
  const completedIds = new Set(
    allTasks(manifest)
      .filter((t) => t.status === "complete")
      .map((t) => t.id)
  );

  return allTasks(manifest).find(
    (t) =>
      t.status === "pending" &&
      t.depends_on.every((dep) => completedIds.has(dep))
  );
}

function allComplete(manifest: Manifest): boolean {
  return allTasks(manifest).every((t) => t.status === "complete");
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
  taskFileContent: string
): Promise<string> {
  // Parse declared files from the task
  let declaredFiles: { path: string; action: string }[] = [];
  try {
    const parsed = JSON.parse(taskFileContent);
    declaredFiles = parsed.files ?? [];
  } catch {
    // If we can't parse the task file something is very wrong — bail
    return "";
  }

  const nonDeleteFiles = declaredFiles
    .filter((f) => f.action !== "delete")
    .map((f) => f.path);

  if (nonDeleteFiles.length === 0) return "";

  // Check filesystem — this is the authoritative source of what's done
  const presentFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const filepath of nonDeleteFiles) {
    if (await Bun.file(filepath).exists()) {
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
    : "**Note:** The previous iteration did not leave notes (likely ran out of context). Use the file list above to orient yourself.";

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
    const result =
      await $`docker sandbox claude --dangerously-skip-permissions --append-system-prompt-file ${agentFile} -p ${prompt}`.text();
    return result;
  } catch (err) {
    // Non-zero exit — return whatever output was produced
    if (err instanceof Error && "stdout" in err) {
      return (err as { stdout: string }).stdout ?? "";
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
}

// ─── Main Loop ────────────────────────────────

await preflight();

printDivider();
console.log("  Ralph Loop started");
console.log(`  Manifest: ${MANIFEST_PATH}`);
printDivider();

while (true) {
  // ── Determine current task ──────────────────
  // Always resume an in_progress task before starting anything new.

  let manifest = await readManifest();
  let task = inProgressTask(manifest);
  let resuming = false;

  if (task) {
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
        console.error("    Check for failed tasks or unresolved dependency cycles.");
        printDivider();
        process.exit(1);
      }
    }

    await updateTask(task.id, (t) => ({ ...t, status: "in_progress" }));
    manifest = await readManifest();
    task = allTasks(manifest).find((t) => t.id === task!.id)!;
  }

  const iteration = (task.progress?.length ?? 0) + 1;
  const taskFile = join(TASKS_DIR, `${task.id}.json`);

  if (!(await Bun.file(taskFile).exists())) {
    console.error(`ERROR: Task file not found: ${taskFile}`);
    process.exit(1);
  }

  printDivider();
  const resumeLabel = resuming ? `  (resuming, iteration ${iteration})` : `  (iteration ${iteration})`;
  console.log(`  Task: ${task.id} — ${task.title}${resumeLabel}`);
  printDivider();

  // ── Build prompt ────────────────────────────

  const executorAgentFile = join(AGENTS_DIR, "task-executor.md");
  const taskFileContent = await Bun.file(taskFile).text();
  const progressContext = await buildProgressContext(task, taskFileContent);

  const prompt = `Your task file:

${taskFileContent}
${progressContext}

---

Manifest location for writing your progress or completion record: ${MANIFEST_PATH}
Current iteration number for progress records: ${iteration}

Implement the task. If you complete it fully, write your completion record and emit <status>COMPLETE</status>.
If you run out of context or cannot finish in this iteration, write a progress record and emit <status>INCOMPLETE</status>.
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

  // Verify completion record was written
  const updatedManifest = await readManifest();
  const completedTask = allTasks(updatedManifest).find((t) => t.id === task!.id)!;

  if (completedTask.completion == null) {
    printDivider();
    console.error(`  ✗ Task ${task.id} emitted COMPLETE but wrote no completion record.`);
    console.error("  Task remains in_progress. Next iteration will retry.");
    printDivider();
    continue;
  }

  // ── Handle drift ────────────────────────────

  if (!completedTask.completion.matched_plan) {
    const driftType = completedTask.completion.drift_type;
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

Follow your instructions. Update affected pending task files. Append to the manifest drift_log.
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
  }

  // ── Verify declared files exist ──────────────

  console.log("\nVerifying output files...");

  const taskData = await Bun.file(taskFile).json();
  const filesToCheck: string[] = taskData.files
    .filter((f: { action: string }) => f.action !== "delete")
    .map((f: { path: string }) => f.path);

  let missing = 0;
  for (const filepath of filesToCheck) {
    if (await Bun.file(filepath).exists()) {
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

  // ── Commit ───────────────────────────────────

  console.log("\nCommitting...");

  try {
    await $`git add -A`.quiet();
    const diffResult = await $`git diff --cached --quiet`.nothrow().quiet();

    if (diffResult.exitCode !== 0) {
      await $`git commit -m ${"feat(" + task.id + "): " + task.title}`;
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
