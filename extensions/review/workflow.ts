import type { Target } from "../../lib/git";
import { parseLastJsonControlBlock } from "../../lib/workflow-prompt";
import {
  DEDUPE_PHASE_FILE,
  GAPFILL_PHASE_FILE,
  HUNT_PHASE_FILE,
  isReadOnlyPhaseFile,
  type WorkflowPhase,
  type WorkflowPhaseFile,
} from "./phases";
import type { NoFixReason, ReviewScope } from "./target-scope";

export const MAX_GAPFILL_LOOPS = 2;

export type PhaseOutput = {
  phaseIndex: number;
  phaseFile: string;
  notes: string;
};

export type ReviewRunSeed = {
  id: string;
  cwd: string;
  targets: Target[];
  diff: string;
  phases: WorkflowPhase[];
  noFix: boolean;
  scope: ReviewScope;
  noFixReason?: NoFixReason;
  instructions: string;
};

export type ActiveReviewRun = ReviewRunSeed & {
  nextPhaseIndex: number;
  phaseOutputs: PhaseOutput[];
  phaseInProgress: boolean;
  gapfillLoopCount: number;
};

export type QueuedPhase = {
  run: ActiveReviewRun;
  phaseIndex: number;
  phase: WorkflowPhase;
};

export type CompletePhaseInput = {
  latestAssistantText?: string;
  truncateNotes: (text: string) => string;
};

export type WorkflowDecision =
  | ({ kind: "queued" } & QueuedPhase)
  | { kind: "completed"; runId: string };

export class ReviewWorkflowController {
  private activeRun: ActiveReviewRun | undefined;

  start(seed: ReviewRunSeed): QueuedPhase {
    this.activeRun = {
      ...seed,
      nextPhaseIndex: 0,
      phaseOutputs: [],
      phaseInProgress: false,
      gapfillLoopCount: 0,
    };

    const phase = this.startQueuedPhase();
    if (!phase) throw new Error("Review workflow has no phases to start");
    return phase;
  }

  startQueuedPhase(): QueuedPhase | undefined {
    if (!this.activeRun || this.activeRun.phaseInProgress) return undefined;

    const phaseIndex = this.activeRun.nextPhaseIndex;
    if (phaseIndex >= this.activeRun.phases.length) {
      this.cancel();
      return undefined;
    }

    this.activeRun.nextPhaseIndex += 1;
    this.activeRun.phaseInProgress = true;
    return {
      run: this.activeRun,
      phaseIndex,
      phase: this.activeRun.phases[phaseIndex],
    };
  }

  completePhase(input: CompletePhaseInput): WorkflowDecision | undefined {
    if (!this.activeRun?.phaseInProgress) return undefined;

    const run = this.activeRun;
    const completedPhaseIndex = run.nextPhaseIndex - 1;
    if (completedPhaseIndex >= 0 && completedPhaseIndex < run.phases.length) {
      const phaseFile = run.phases[completedPhaseIndex].file;
      run.phaseOutputs.push({
        phaseIndex: completedPhaseIndex,
        phaseFile,
        notes: input.truncateNotes(input.latestAssistantText ?? ""),
      });
    }

    run.phaseInProgress = false;
    const nextPhaseIndex = decideNextPhaseIndex(
      run,
      completedPhaseIndex,
      input.latestAssistantText,
    );

    if (nextPhaseIndex === undefined) {
      const runId = run.id;
      this.activeRun = undefined;
      return { kind: "completed", runId };
    }

    run.nextPhaseIndex = nextPhaseIndex;
    return {
      kind: "queued",
      run,
      phaseIndex: nextPhaseIndex,
      phase: run.phases[nextPhaseIndex],
    };
  }

  cancel(): void {
    this.activeRun = undefined;
  }

  getActiveRun(): ActiveReviewRun | undefined {
    return this.activeRun;
  }

  currentPhaseFile(): WorkflowPhaseFile | undefined {
    if (!this.activeRun?.phaseInProgress) return undefined;
    const index = this.activeRun.nextPhaseIndex - 1;
    return index >= 0 ? this.activeRun.phases[index]?.file : undefined;
  }

  isReadOnlyPhase(): boolean {
    const phaseFile = this.currentPhaseFile();
    if (!phaseFile) return false;
    return Boolean(this.activeRun?.noFix) || isReadOnlyPhaseFile(phaseFile);
  }
}

function parseContinueHunt(text: string | undefined): boolean {
  return (
    parseLastJsonControlBlock<{ continue_hunt?: unknown }>(text, "review_control")
      ?.continue_hunt === true
  );
}

function findPhaseIndex(run: ActiveReviewRun, phaseFile: WorkflowPhaseFile): number {
  const index = run.phases.findIndex((phase) => phase.file === phaseFile);
  if (index < 0) throw new Error(`Workflow phase not found in run: ${phaseFile}`);
  return index;
}

function decideNextPhaseIndex(
  run: ActiveReviewRun,
  completedPhaseIndex: number,
  latestAssistantText: string | undefined,
): number | undefined {
  const completedPhaseFile = run.phases[completedPhaseIndex]?.file;

  if (completedPhaseFile === GAPFILL_PHASE_FILE) {
    if (parseContinueHunt(latestAssistantText) && run.gapfillLoopCount < MAX_GAPFILL_LOOPS) {
      run.gapfillLoopCount += 1;
      return findPhaseIndex(run, HUNT_PHASE_FILE);
    }

    return findPhaseIndex(run, DEDUPE_PHASE_FILE);
  }

  const next = completedPhaseIndex + 1;
  return next < run.phases.length ? next : undefined;
}
