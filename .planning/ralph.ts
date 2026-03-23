#!/usr/bin/env bun

/** biome-ignore-all lint/suspicious/noConsole: logging is expected */
/** biome-ignore-all lint/style/useNamingConvention: this is fine for now */

// ─────────────────────────────────────────────
// Ralph Loop
// Executes tasks from .planning/tasks/manifest.json
// one at a time until all are complete.
//
// A task takes as many iterations as it needs.
// Each iteration resumes where the last left off.
//
// Run: bun .planning/ralph.ts
// ─────────────────────────────────────────────

import {$} from 'bun'
import {join, resolve} from 'node:path'
import process from 'node:process'

// Resolve the project root once at startup so all paths are absolute
// and the Docker sandbox can be given an explicit workspace mount.
const PROJECT_ROOT = resolve('.')
const MANIFEST_PATH = join(PROJECT_ROOT, '.planning/tasks/manifest.json')
const TASKS_DIR = join(PROJECT_ROOT, '.planning/tasks')
const AGENTS_DIR = join(PROJECT_ROOT, '.planning/agents')

// ─── Types ────────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped'

interface ProgressEntry {
  iteration: number
  completed_files: string[]
  remaining_files: string[]
  notes: string
}

interface BrokenAssumption {
  assumption_id: string
  assumption: string
  reality: string
}

interface CompletionRecord {
  summary: string
  matched_plan: boolean
  drift_type: 'none' | 'local' | 'structural' | 'decision' | 'additive'
  broken_assumptions: BrokenAssumption[]
  notes: string | null
}

interface DriftLogEntry {
  triggered_by: string
  drift_type: 'local' | 'structural' | 'decision' | 'additive'
  tasks_updated: string[]
  engineer_flagged: boolean
  summary: string
}

interface ManifestTask {
  id: string
  file: string
  title: string
  depends_on: string[]
  status: TaskStatus
  failed_reason?: string | null
  progress?: ProgressEntry[]
  completion?: CompletionRecord | null
  loop_verified?: boolean
}

interface Manifest {
  tasks: ManifestTask[]
  drift_log: DriftLogEntry[]
}

// ─── Manifest helpers ─────────────────────────

async function readManifest(): Promise<Manifest> {
  return await Bun.file(MANIFEST_PATH).json()
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

function inProgressTask(manifest: Manifest): ManifestTask | undefined {
  return manifest.tasks.find(t => t.status === 'in_progress')
}

// IDs of tasks that count as resolved for dependency purposes.
function resolvedIds(manifest: Manifest): Set<string> {
  return new Set(
    manifest.tasks
      .filter(t => t.status === 'complete' || t.status === 'skipped')
      .map(t => t.id)
  )
}

function nextFailedTask(manifest: Manifest): ManifestTask | undefined {
  const resolved = resolvedIds(manifest)
  return manifest.tasks.find(
    t => t.status === 'failed' && t.depends_on.every(dep => resolved.has(dep))
  )
}

function nextPendingTask(manifest: Manifest): ManifestTask | undefined {
  const resolved = resolvedIds(manifest)
  return manifest.tasks.find(
    t => t.status === 'pending' && t.depends_on.every(dep => resolved.has(dep))
  )
}

function allComplete(manifest: Manifest): boolean {
  return manifest.tasks.every(
    t => t.status === 'complete' || t.status === 'skipped'
  )
}

async function updateTask(
  taskId: string,
  updater: (task: ManifestTask) => ManifestTask
): Promise<void> {
  const manifest = await readManifest()
  const idx = manifest.tasks.findIndex(t => t.id === taskId)
  if (idx !== -1) {
    manifest.tasks[idx] = updater(manifest.tasks[idx])
  }
  await writeManifest(manifest)
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
  let declaredFiles: {path: string; action: string}[] = []
  try {
    const parsed = JSON.parse(taskFileContent)
    declaredFiles = parsed.files ?? []
  } catch {
    // If we can't parse the task file something is very wrong — bail
    return ''
  }

  const nonDeleteFiles = declaredFiles
    .filter(f => f.action !== 'delete')
    .map(f => f.path)

  if (nonDeleteFiles.length === 0) return ''

  // Check filesystem — this is the authoritative source of what's done
  const presentFiles: string[] = []
  const missingFiles: string[] = []

  for (const filepath of nonDeleteFiles) {
    if (await Bun.file(join(PROJECT_ROOT, filepath)).exists()) {
      presentFiles.push(filepath)
    } else {
      missingFiles.push(filepath)
    }
  }

  // If nothing has been written yet and no progress records exist,
  // this is a fresh start — no resumption context needed
  const hasProgress = task.progress && task.progress.length > 0
  if (presentFiles.length === 0 && !hasProgress) return ''

  const iterationCount = task.progress?.length ?? 0

  // Pull the last agent-written notes if they exist
  const lastNotes =
    task.progress && task.progress.length > 0 && task.progress.at(-1)?.notes

  const notesSection = lastNotes
    ? `**Where the last iteration left off (agent notes):**\n${lastNotes}`
    : '**Note:** The previous iteration did not leave notes. Use the file list above to orient yourself.'

  return `

---

## Resumption Context

This task has been attempted ${iterationCount} time(s) and is not yet complete. Do not start over.

**Files confirmed present on disk** (do not rewrite unless broken):
${presentFiles.length > 0 ? presentFiles.map(f => `- ${f}`).join('\n') : '- None yet'}

${notesSection}

**Files still remaining:**
${missingFiles.length > 0 ? missingFiles.map(f => `- ${f}`).join('\n') : '- None — all files are present. Verify correctness and emit COMPLETE if done.'}

Pick up where the previous iteration left off. Check what is already on disk before writing anything.`
}

// ─── Status signal parsing ────────────────────

type StatusSignal =
  | {type: 'COMPLETE'}
  | {type: 'INCOMPLETE'}
  | {type: 'FAILED'; reason: string}
  | {type: 'MISSING'}

function parseStatusSignal(output: string): StatusSignal {
  if (output.includes('<status>COMPLETE</status>')) return {type: 'COMPLETE'}
  if (output.includes('<status>INCOMPLETE</status>'))
    return {type: 'INCOMPLETE'}

  const failedMatch = output.match(/<status>FAILED:\s*(.*?)<\/status>/s)
  if (failedMatch) return {type: 'FAILED', reason: failedMatch[1].trim()}

  return {type: 'MISSING'}
}

// ─── Claude invocation ────────────────────────

async function runClaude(agentFile: string, prompt: string): Promise<string> {
  const proc = Bun.spawn(
    [
      'docker',
      'sandbox',
      'run',
      'claude',
      PROJECT_ROOT,
      '--',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file',
      agentFile,
      '-p',
      prompt,
    ],
    {stdout: 'pipe', stderr: 'pipe'}
  )

  // Stream both stdout and stderr in real-time while capturing everything
  // into a single string for signal parsing.
  let output = ''
  const decoder = new TextDecoder()

  async function drain(
    stream: ReadableStream<Uint8Array>,
    dest: NodeJS.WriteStream
  ) {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk)
      output += text
      dest.write(text)
    }
  }

  await Promise.all([
    drain(proc.stdout, process.stdout),
    drain(proc.stderr, process.stderr),
  ])

  await proc.exited
  return output
}

// ─── Display helpers ──────────────────────────

const DIVIDER = `\n${'━'.repeat(50)}`

function printDivider() {
  console.log(DIVIDER)
}

function printManifestSummary(manifest: Manifest): void {
  const counts = {
    pending: 0,
    in_progress: 0,
    complete: 0,
    failed: 0,
    skipped: 0,
  }
  for (const t of manifest.tasks) counts[t.status]++
  const total = manifest.tasks.length
  const done = counts.complete + counts.skipped
  const parts: string[] = []
  if (counts.complete > 0) parts.push(`${counts.complete} complete`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.pending > 0) parts.push(`${counts.pending} pending`)
  console.log(`  Progress: ${done}/${total} done (${parts.join(', ')})`)
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = Math.round(secs % 60)
  return `${mins}m ${remainSecs}s`
}

// ─── Preflight ────────────────────────────────

async function preflight(): Promise<void> {
  const checks = [
    {path: MANIFEST_PATH, label: 'Manifest'},
    {
      path: join(AGENTS_DIR, 'task-executor.md'),
      label: 'Task executor agent',
    },
    {
      path: join(AGENTS_DIR, 'drift-response.md'),
      label: 'Drift response agent',
    },
  ]

  for (const {path, label} of checks) {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      console.error(`ERROR: ${label} not found at ${path}`)
      if (path === MANIFEST_PATH) {
        console.error(
          'Complete Phase 7 (Task Generation) before running the Ralph Loop.'
        )
      }
      process.exit(1)
    }
  }

  // Verify git is available and the project is a git repository.
  const gitCheck = await $`git rev-parse --is-inside-work-tree`
    .nothrow()
    .quiet()
  if (gitCheck.exitCode !== 0) {
    console.error('ERROR: Not a git repository (or git is not installed).')
    console.error(
      'Initialize a git repo (`git init`) before running the Ralph Loop.'
    )
    process.exit(1)
  }

  // Validate the dependency graph is a DAG (no cycles).
  const manifest = await readManifest()
  const tasks = manifest.tasks
  const taskIds = new Set(tasks.map(t => t.id))

  // Check for references to non-existent tasks while building adjacency.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!taskIds.has(dep)) {
        console.error(
          `ERROR: Task ${t.id} depends on ${dep}, which does not exist in the manifest.`
        )
        process.exit(1)
      }
    }
  }

  // Topological sort via Kahn's algorithm to detect cycles.
  const inDegree = new Map<string, number>(tasks.map(t => [t.id, 0]))
  for (const t of tasks) {
    for (const _dep of t.depends_on) {
      const num = inDegree.get(t.id)

      if (num !== undefined) {
        inDegree.set(t.id, num + 1)
      }
    }
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  let sorted = 0
  while (queue.length > 0) {
    const current = queue.shift() ?? ''
    sorted++
    // Find tasks that depend on `current` and decrement their in-degree.
    for (const t of tasks) {
      if (t.depends_on.includes(current)) {
        const num = inDegree.get(t.id)

        if (num !== undefined) {
          const newDeg = num - 1
          inDegree.set(t.id, newDeg)
          if (newDeg === 0) queue.push(t.id)
        }
      }
    }
  }

  if (sorted !== tasks.length) {
    const stuck = tasks
      .filter(t => {
        const num = inDegree.get(t.id)
        return num !== undefined && num > 0
      })
      .map(t => t.id)
    console.error(
      `ERROR: Dependency cycle detected involving: ${stuck.join(', ')}`
    )
    console.error(
      'Fix the dependency graph in the manifest before running the loop.'
    )
    process.exit(1)
  }
}

// ─── Main Loop ────────────────────────────────

await preflight()

const loopStartTime = new Date()

printDivider()
console.log('  Ralph Loop started')
console.log(`  Started at: ${loopStartTime.toLocaleString()}`)
console.log(`  Manifest: ${MANIFEST_PATH}`)
{
  const initial = await readManifest()
  printManifestSummary(initial)
}
printDivider()

let loopIterationCount = 0

while (true) {
  loopIterationCount++
  console.log(`\n🔄 Loop iteration ${loopIterationCount}`)

  // ── Check for unverified complete tasks ─────
  // If the agent wrote status: "complete" but the loop never ran file
  // verification or drift handling (e.g., the agent crashed after writing
  // the manifest but before emitting the signal), revert to in_progress
  // so the normal COMPLETE path runs on the next pick-up.

  {
    const checkManifest = await readManifest()
    const unverified = checkManifest.tasks.find(
      t => t.status === 'complete' && t.completion != null && !t.loop_verified
    )
    if (unverified) {
      console.log(
        `\n⚠ Task ${unverified.id} is marked complete but was never verified. Re-entering COMPLETE path.`
      )
      await updateTask(unverified.id, t => ({...t, status: 'in_progress'}))
    }
  }

  // ── Determine current task ──────────────────
  // Always resume an in_progress task before starting anything new.

  let manifest = await readManifest()
  let task = inProgressTask(manifest)
  let resuming = false

  if (task) {
    resuming = true
  } else {
    // Failed tasks take priority — they represent a previous iteration
    // the engineer has since resolved.
    task = nextFailedTask(manifest)

    if (task) {
      console.log(
        `\n↻ Retrying previously failed task: ${task.id} — ${task.title}`
      )
      await updateTask(task.id, t => ({
        ...t,
        status: 'in_progress',
        failed_reason: null,
        completion: null,
      }))
      manifest = await readManifest()
      const currentTask = task
      task = manifest.tasks.find(t => t.id === currentTask.id)

      if (!task) {
        throw new Error(
          'No task found from the manifest when retrying previously failed task'
        )
      }

      resuming = true
    } else {
      task = nextPendingTask(manifest)

      if (!task) {
        if (allComplete(manifest)) {
          const loopEndTime = new Date()
          printDivider()
          console.log('  ✓ All tasks complete.')
          console.log(`  Finished at: ${loopEndTime.toLocaleString()}`)
          console.log(
            `  Total elapsed: ${formatElapsed(loopEndTime.getTime() - loopStartTime.getTime())}`
          )
          printDivider()
          process.exit(0)
        } else {
          printDivider()
          console.error(
            '  ✗ No runnable tasks found and not all tasks are complete.'
          )
          console.error('    Check for unresolved dependency cycles.')
          printDivider()
          process.exit(1)
        }
      }

      await updateTask(task.id, t => ({...t, status: 'in_progress'}))
      manifest = await readManifest()
      const currentTask = task
      task = manifest.tasks.find(t => t.id === currentTask.id)

      if (!task) {
        throw new Error('No task found from the manifest')
      }
    }
  }

  const taskAttemptCount = (task.progress?.length ?? 0) + 1
  const taskFile = join(PROJECT_ROOT, task.file)

  if (!(await Bun.file(taskFile).exists())) {
    console.error(`ERROR: Task file not found: ${taskFile}`)
    process.exit(1)
  }

  printDivider()
  const resumeLabel = resuming
    ? `  (resuming, attempt ${taskAttemptCount})`
    : `  (attempt ${taskAttemptCount})`
  console.log(`  Task: ${task.id} — ${task.title}${resumeLabel}`)
  printManifestSummary(manifest)
  printDivider()

  // ── Build prompt ────────────────────────────

  const executorAgentFile = join(AGENTS_DIR, 'task-executor.md')
  const taskFileContent = await Bun.file(taskFile).text()
  const progressContext = await buildProgressContext(task, taskFileContent)

  const prompt = `Your task file:

${taskFileContent}
${progressContext}

---

Manifest location for writing your progress or completion record: ${MANIFEST_PATH}
Current iteration number for progress records: ${taskAttemptCount}

Implement the task. If you complete it fully, write your completion record and emit <status>COMPLETE</status>.
If you have made progress but cannot finish in this iteration, write a progress record and emit <status>INCOMPLETE</status>.
If the task cannot be completed, write your completion record and emit <status>FAILED: reason</status>.`

  // ── Execute ─────────────────────────────────

  console.log('\n▶ Executing task...\n')
  const execStart = performance.now()
  const execResult = await runClaude(executorAgentFile, prompt)
  const execElapsed = performance.now() - execStart
  console.log(`\n⏱  Task executor finished in ${formatElapsed(execElapsed)}`)

  // ── Parse status signal ─────────────────────

  const signal = parseStatusSignal(execResult)

  // ── Handle missing signal ───────────────────
  // Agent crashed or was killed. Task stays in_progress.
  // Next iteration will resume it.

  if (signal.type === 'MISSING') {
    printDivider()
    console.log('  ⚠  No status signal detected — treating as incomplete.')
    console.log('  The agent may have crashed or exhausted its context.')
    console.log('  The loop will resume this task on the next iteration.')
    printDivider()
    // Continue to next iteration — task is still in_progress
    continue
  }

  // ── Handle INCOMPLETE ───────────────────────
  // Agent wrote a progress record. Loop continues to next iteration
  // on the same task. No exit.

  if (signal.type === 'INCOMPLETE') {
    console.log(
      `\n↻ Attempt ${taskAttemptCount} incomplete — resuming on next iteration.`
    )
    // Task remains in_progress. Continue the while loop.
    continue
  }

  // ── Handle FAILED ───────────────────────────

  if (signal.type === 'FAILED') {
    await updateTask(task.id, t => ({
      ...t,
      status: 'failed',
      failed_reason: signal.reason,
    }))

    printDivider()
    console.log(`  ✗  Task ${task.id} failed`)
    console.log()
    console.log(`  ${signal.reason}`)
    console.log()
    console.log('  Resolve the failure then re-run the loop.')
    console.log('  See Phase 8 in the workflow for resolution guidance.')
    printDivider()
    process.exit(1)
  }

  // ── COMPLETE path ────────────────────────────

  console.log('\n── Post-execution: verifying completion ──')

  // Verify completion record was written
  const updatedManifest = await readManifest()
  const completedTask = updatedManifest.tasks.find(t => t.id === task.id)

  if (!completedTask) {
    throw new Error('No completed task found')
  }

  if (completedTask.completion == null) {
    printDivider()
    console.error(
      `  ✗ Task ${task.id} emitted COMPLETE but wrote no completion record.`
    )
    console.error('  Task remains in_progress. Next iteration will retry.')
    printDivider()
    continue
  }

  // ── Verify declared files exist ──────────────
  // This must happen BEFORE setting status to "complete" — if files are
  // missing the task stays in_progress so the next iteration retries it.

  console.log('\n── Post-execution: verifying output files ──')

  const taskData = await Bun.file(taskFile).json()
  const filesToCheck: string[] = taskData.files
    .filter((f: {action: string}) => f.action !== 'delete')
    .map((f: {path: string}) => f.path)
  const testFilesToCheck: string[] = taskData.test_files ?? []

  let missing = 0
  for (const filepath of [...filesToCheck, ...testFilesToCheck]) {
    if (await Bun.file(join(PROJECT_ROOT, filepath)).exists()) {
      console.log(`  ✓ ${filepath}`)
    } else {
      console.log(`  ✗ Missing: ${filepath}`)
      missing++
    }
  }

  if (missing > 0) {
    printDivider()
    console.error(
      `  ✗ ${missing} declared file(s) not found after task execution.`
    )
    console.error('  Task remains in_progress. Next iteration will retry.')
    printDivider()
    continue
  }

  // Defensive: ensure status is "complete" even if the executor only wrote
  // the completion record but failed to update the status field.
  if (completedTask.status !== 'complete') {
    await updateTask(task.id, t => ({...t, status: 'complete'}))
  }

  // ── Handle drift ────────────────────────────

  if (!completedTask.completion.matched_plan) {
    const driftType = completedTask.completion.drift_type

    // Local drift means internals differed but the external surface matched.
    // No downstream tasks are affected — just log it and move on.
    if (driftType === 'local') {
      console.log(
        '\n⚡ Drift detected (type: local) — no downstream impact, logging.\n'
      )
      const manifest = await readManifest()
      manifest.drift_log.push({
        triggered_by: task.id,
        drift_type: 'local',
        tasks_updated: [],
        engineer_flagged: false,
        summary: completedTask.completion.summary,
      })
      await writeManifest(manifest)
    } else {
      // structural, decision, or additive — spawn the Drift Response agent.
      console.log(
        `\n⚡ Drift detected (type: ${driftType}) — running Drift Response agent...\n`
      )

      const driftAgentFile = join(AGENTS_DIR, 'drift-response.md')
      const taskEntry = JSON.stringify(completedTask, null, 2)
      const fullManifest = await Bun.file(MANIFEST_PATH).text()

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
<drift_resolved/>`

      const driftStart = performance.now()
      const driftResult = await runClaude(driftAgentFile, driftPrompt)
      const driftElapsed = performance.now() - driftStart
      console.log(
        `\n⏱  Drift response agent finished in ${formatElapsed(driftElapsed)}`
      )

      const engineerMatch = driftResult.match(
        /<engineer_required>([\s\S]*?)<\/engineer_required>/
      )

      if (engineerMatch) {
        printDivider()
        console.log(
          '  🛑 Engineer input required before execution can continue'
        )
        console.log()
        console.log(engineerMatch[1].trim())
        console.log()
        console.log(
          '  Resolve the decision, update the Technical Spec if needed,'
        )
        console.log('  then re-run the loop.')
        printDivider()
        process.exit(1)
      }

      const resolved = /<drift_resolved\s*\/>/.test(driftResult)
      if (!resolved) {
        printDivider()
        console.error('  ✗ Drift Response agent produced no status signal.')
        console.error('  Expected <drift_resolved/> or <engineer_required>.')
        console.error('  Halting to avoid advancing with unresolved drift.')
        printDivider()
        process.exit(1)
      }
    }
  }

  // ── Mark as verified ────────────────────────
  // The loop has confirmed files exist and handled drift. Mark the task
  // so the unverified-complete check at the top of the loop won't re-enter.
  await updateTask(task.id, t => ({
    ...t,
    status: 'complete',
    loop_verified: true,
  }))

  // ── Commit ───────────────────────────────────

  console.log('\n── Post-execution: committing ──')

  try {
    // Stage only the files this task is responsible for:
    // 1. Declared implementation files from the task's files array
    // 2. Declared test files from the task's test_files array
    // 3. The .planning/ directory (manifest updates, drift log, task file edits)

    const allTaskFiles = filesToCheck.concat(taskData.test_files ?? [])

    if (allTaskFiles.length > 0) {
      const filesToStage = allTaskFiles
        .map(f => $.escape(join(PROJECT_ROOT, f)))
        .join(' ')
      await $`git add ${{raw: filesToStage}}`.quiet()
    }
    await $`git add ${join(PROJECT_ROOT, '.planning/')}`.quiet()

    const diffResult = await $`git diff --cached --quiet`.nothrow().quiet()

    if (diffResult.exitCode === 0) {
      console.log('  Nothing new to commit.')
    } else {
      const commitType: string = taskData.commit_type ?? 'feat'
      await $`git commit -m ${`${commitType}(${task.id}): ${task.title}`}`
    }
  } catch (err) {
    console.error('  Git commit failed:', err)
    process.exit(1)
  }

  // ── Done ─────────────────────────────────────

  console.log(`\n✓ ${task.id} complete after ${taskAttemptCount} attempt(s).`)
}
