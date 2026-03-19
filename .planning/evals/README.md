# Workflow Evals

Evaluation suite for the AI-Assisted Software Planning Workflow. Tests each agent prompt and the system prompt for correctness, adherence to workflow rules, and output quality.

## Structure

```
evals/
├── fixtures/                  # Shared test data used across all evals
│   ├── behavioral-spec.json   # 5-scenario bookmark manager spec
│   ├── technical-vision.md    # Engineer's technical intent
│   ├── technical-spec.json    # Locked technical decisions
│   ├── sample-task.json       # A single task file (T01)
│   ├── sample-manifest.json   # Manifest with T01 complete + drift, T02-T04 pending
│   └── sample-braindump.md    # Raw engineer brain dump
├── codebase-auditor/          # Codebase Auditor agent evals
│   ├── SKILL.md
│   └── evals/evals.json       # 3 eval cases
├── task-generator/            # Task Generator agent evals
│   ├── SKILL.md
│   └── evals/evals.json       # 3 eval cases
├── task-executor/             # Task Executor agent evals
│   ├── SKILL.md
│   └── evals/evals.json       # 3 eval cases (TDD discipline, drift reporting, resumption)
├── drift-response/            # Drift Response agent evals
│   ├── SKILL.md
│   └── evals/evals.json       # 3 eval cases (structural, decision, additive drift)
└── system-prompt/             # System Prompt conversational evals
    ├── SKILL.md
    └── evals/evals.json       # 3 eval cases (behavioral-only dump, mixed dump, Mode 3 skip)
```

## Running Evals

Use the skill-creator's eval pipeline. From a Claude Code or Cowork session:

```
/skill-creator
```

Then ask it to run evals for a specific agent:

- "Run evals on the task generator at .planning/evals/task-generator"
- "Benchmark the drift response agent at .planning/evals/drift-response across 3 runs"
- "A/B test the codebase auditor — compare the current version against a modified one"

## What Each Eval Suite Tests

### Codebase Auditor (3 evals)
1. Full audit with behavioral spec + technical vision — checks all 8 output files, tension sections, file paths
2. Audit without technical vision — verifies graceful handling when no vision exists
3. Technical vision-driven depth — checks that the auditor digs deeper into technologies the vision mentions

### Task Generator (3 evals)
1. Basic task generation — coverage, acyclicity, self-containment, naming
2. Technical vision context — checks that vision informs task notes without overriding locked decisions
3. Task sizing — verifies vertical slices, no oversized or undersized tasks

### Task Executor (3 evals)
1. TDD discipline — tests written before implementation, confirmed failing, completion record ordering
2. Drift reporting — accurate classification of structural drift with broken assumptions
3. Resumption — handles iteration 2 correctly, doesn't rewrite existing files

### Drift Response (3 evals)
1. Structural drift — scans pending tasks, updates affected files, emits drift_resolved
2. Decision drift — halts for engineer input, emits engineer_required (never drift_resolved)
3. Additive drift — updates notes in affected tasks, emits drift_resolved

### System Prompt (3 evals)
1. Behavioral-only brain dump — empty Technical Seeds, no invented technical content
2. Mixed brain dump — correctly separates behavioral and technical seeds
3. Mode 3 skip logic — skips technical grilling when no seeds, transitions to Phase 3

## Adding Test Cases

Add entries to the relevant `evals/evals.json`. Each eval needs:
- `id`: Unique integer
- `prompt`: The task prompt (what to tell the agent)
- `expected_output`: Human description of what success looks like
- `expectations`: List of verifiable assertions for automated grading

## Retesting Against New Models

Re-run the same eval suite with a different model to compare performance. The skill-creator's benchmark mode runs each eval multiple times and reports variance, pass rates, and timing — making it easy to spot regressions when switching models.
