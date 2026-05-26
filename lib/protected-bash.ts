import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";

export type RepoGitPaths = {
  worktree: string;
  dotGit: string;
  gitDir: string;
  gitCommonDir: string;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export type ProtectedBashError = {
  kind:
    | "sandbox_unavailable"
    | "repo_git_paths_unavailable"
    | "fingerprint_capture_failed"
    | "fingerprint_mismatch"
    | "sandbox_denial";
  message: string;
};

export type ProtectedBashResult = {
  exitCode: number | null;
  output: string;
  violation?: ProtectedBashError;
};

const SANDBOX_INIT_TIMEOUT_MS = 10_000;
const GIT_EXEC_TIMEOUT_MS = 5_000;
const PROTECTED_BASH_TIMEOUT_DEFAULT = 120;

let sandboxReady = false;

export async function resetSandboxState(): Promise<void> {
  sandboxReady = false;
  await SandboxManager.reset();
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function sandboxWriteAllowPaths(): string[] {
  if (process.platform === "darwin") return ["/"];

  return [
    ...new Set([tmpdir(), process.env.TMPDIR, "/tmp", "/var/tmp", "/dev/shm"].filter(isString)),
  ];
}

/**
 * Resolve all git paths that need write protection.
 */
export async function resolveRepoGitPaths(exec: ExecFn, cwd: string): Promise<RepoGitPaths> {
  const run = (args: string[]) =>
    exec("git", ["-C", cwd, ...args], { timeout: GIT_EXEC_TIMEOUT_MS });

  const [toplevelResult, gitDirResult, commonDirResult] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--git-dir"]),
    run(["rev-parse", "--git-common-dir"]),
  ]);

  if (toplevelResult.code !== 0) {
    throw new Error(
      `Failed to resolve git worktree: ${toplevelResult.stderr.trim() || toplevelResult.stdout.trim()}`,
    );
  }

  const worktree = toplevelResult.stdout.trim();
  const gitDirRaw =
    gitDirResult.code === 0 ? gitDirResult.stdout.trim() : resolve(worktree, ".git");
  const commonDirRaw = commonDirResult.code === 0 ? commonDirResult.stdout.trim() : gitDirRaw;

  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(worktree, gitDirRaw);
  const gitCommonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(worktree, commonDirRaw);
  const dotGit = resolve(worktree, ".git");

  return { worktree, dotGit, gitDir, gitCommonDir };
}

/**
 * Build a SandboxRuntimeConfig that denies writes to repo paths.
 * sandbox-runtime uses an allow-only write model. On macOS, root writes can
 * be allowed and repo paths carved out with denyWrite. On Linux, avoid root
 * allowWrite because sandbox-runtime's denyWrite path check does not treat
 * root as an ancestor; keep scratch locations writable instead.
 */
export function buildRepoSandboxConfig(repo: RepoGitPaths): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [],
      allowWrite: sandboxWriteAllowPaths(),
      denyWrite: [repo.worktree, repo.gitDir, repo.gitCommonDir, repo.dotGit],
    },
  };
}

/**
 * Capture a lightweight repo fingerprint via git status.
 */
export async function captureRepoFingerprint(exec: ExecFn, cwd: string): Promise<string> {
  const result = await exec(
    "git",
    ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { timeout: GIT_EXEC_TIMEOUT_MS },
  );

  if (result.code !== 0) {
    throw new Error(
      `Failed to capture repo fingerprint: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  // Hash the output for stable comparison
  const encoder = new TextEncoder();
  const data = encoder.encode(result.stdout);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const FINGERPRINT_MISMATCH_ERROR =
  "PROTECTED_READ_ONLY_BASH: The original repository changed during a read-only command. " +
  "This indicates a sandbox protection gap or an unexpected mutation. " +
  "The repository fingerprint after the command differs from the baseline. " +
  "Manual inspection of repository state is required.";

const SANDBOX_UNAVAILABLE_ERROR =
  "PROTECTED_READ_ONLY_BASH: Sandbox runtime is unavailable on this platform or could not be initialized. " +
  "Read-only bash commands cannot be executed safely without OS-level sandbox protection.";

const REPO_GIT_PATHS_UNAVAILABLE_ERROR =
  "PROTECTED_READ_ONLY_BASH: Could not resolve repository git paths. " +
  "Protected bash requires a git repository with accessible git metadata.";

/**
 * Initialize the sandbox with repo protection. Safe to call multiple times.
 * Returns true on success, false if sandbox is unavailable (fail-closed).
 */
export async function initializeProtectedSandbox(
  exec: ExecFn,
  cwd: string,
): Promise<{ ok: true; config: SandboxRuntimeConfig } | { ok: false; reason: string }> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return { ok: false, reason: SANDBOX_UNAVAILABLE_ERROR };
  }

  let repo: RepoGitPaths;
  try {
    repo = await resolveRepoGitPaths(exec, cwd);
  } catch (error) {
    return {
      ok: false,
      reason: `${REPO_GIT_PATHS_UNAVAILABLE_ERROR} (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const config = buildRepoSandboxConfig(repo);
  if (sandboxReady) return { ok: true, config };

  try {
    await Promise.race([
      SandboxManager.initialize(config),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Sandbox initialization timed out")),
          SANDBOX_INIT_TIMEOUT_MS,
        ),
      ),
    ]);

    sandboxReady = true;
    return { ok: true, config };
  } catch (error) {
    return {
      ok: false,
      reason: `${SANDBOX_UNAVAILABLE_ERROR} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * Create BashOperations that wrap each command through the OS sandbox
 * and check the repository fingerprint before and after execution.
 */
export function createProtectedBashOperations(exec: ExecFn, cwd: string): BashOperations {
  return {
    async exec(command, commandCwd, { onData, signal, timeout }) {
      const effectiveCwd = commandCwd || cwd;
      if (!existsSync(effectiveCwd)) {
        throw new Error(`Working directory does not exist: ${effectiveCwd}`);
      }

      const initResult = await initializeProtectedSandbox(exec, effectiveCwd);
      if (!initResult.ok) {
        throw new Error(initResult.reason);
      }

      // 1. Capture baseline fingerprint
      let beforeFingerprint: string;
      try {
        beforeFingerprint = await captureRepoFingerprint(exec, effectiveCwd);
      } catch (error) {
        throw new Error(
          `Failed to capture repository fingerprint before executing read-only command: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 2. Wrap command through sandbox
      let wrappedCommand: string;
      try {
        wrappedCommand = await SandboxManager.wrapWithSandbox(
          command,
          undefined,
          initResult.config,
          signal,
        );
      } catch (error) {
        throw new Error(
          `Failed to wrap command with sandbox: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 3. Execute through sandbox
      let exitCode: number | null;
      try {
        exitCode = await new Promise<number | null>((resolve, reject) => {
          const child = spawn("bash", ["-c", wrappedCommand], {
            cwd: effectiveCwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let timedOut = false;
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

          const effectiveTimeout = timeout ?? PROTECTED_BASH_TIMEOUT_DEFAULT;

          if (effectiveTimeout > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              if (child.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              }
            }, effectiveTimeout * 1000);
          }

          child.stdout?.on("data", onData);
          child.stderr?.on("data", onData);

          child.on("error", (err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(err);
          });

          const onAbort = () => {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          };

          signal?.addEventListener("abort", onAbort, { once: true });

          child.on("close", (code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);

            if (signal?.aborted) {
              reject(new Error("aborted"));
            } else if (timedOut) {
              reject(new Error(`timeout:${effectiveTimeout}`));
            } else {
              resolve(code);
            }
          });
        });
      } finally {
        SandboxManager.cleanupAfterCommand();
      }

      // 4. Check fingerprint after execution
      let afterFingerprint: string;
      try {
        afterFingerprint = await captureRepoFingerprint(exec, effectiveCwd);
      } catch (error) {
        throw new Error(
          `${FINGERPRINT_MISMATCH_ERROR} additionally, fingerprint capture after command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (beforeFingerprint !== afterFingerprint) {
        throw new Error(FINGERPRINT_MISMATCH_ERROR);
      }

      return { exitCode };
    },
  };
}

/**
 * Create BashOperations that always fail (fail-closed).
 * Used when sandbox initialization failed and we must not expose mutable bash.
 */
export function createFailClosedBashOperations(reason: string): BashOperations {
  return {
    async exec(_command, _cwd, _options) {
      throw new Error(reason);
    },
  };
}

/**
 * Create the standard local BashOperations.
 * Used when not in a read-only phase.
 */
export function createStandardBashOperations(): BashOperations {
  return createLocalBashOperations();
}

/**
 * Full protected bash executor that returns structured result
 * including fingerprint, sandbox denial, or error.
 */
export async function executeProtectedBash(
  command: string,
  cwd: string,
  exec: ExecFn,
  signal?: AbortSignal,
  timeout?: number,
): Promise<ProtectedBashResult> {
  // Initialize sandbox if needed
  const initResult = await initializeProtectedSandbox(exec, cwd);
  if (!initResult.ok) {
    return {
      exitCode: null,
      output: initResult.reason,
      violation: { kind: "sandbox_unavailable", message: initResult.reason },
    };
  }

  let beforeFingerprint: string;
  try {
    beforeFingerprint = await captureRepoFingerprint(exec, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: null,
      output: `Failed to capture repository fingerprint: ${message}`,
      violation: { kind: "fingerprint_capture_failed", message },
    };
  }

  if (!existsSync(cwd)) {
    return {
      exitCode: null,
      output: `Working directory does not exist: ${cwd}`,
      violation: {
        kind: "sandbox_unavailable",
        message: `Working directory does not exist: ${cwd}`,
      },
    };
  }

  let wrappedCommand: string;
  try {
    wrappedCommand = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      initResult.config,
      signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: null,
      output: message,
      violation: { kind: "sandbox_unavailable", message },
    };
  }

  let exitCode: number | null;
  let output: string;
  try {
    ({ exitCode, output } = await new Promise<{
      exitCode: number | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const effectiveTimeout = timeout ?? PROTECTED_BASH_TIMEOUT_DEFAULT;

      if (effectiveTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }, effectiveTimeout * 1000);
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      const onAbort = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${effectiveTimeout}`));
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("\n");
        resolve({ exitCode: code, output: output || "[no output]" });
      });
    }));
  } finally {
    SandboxManager.cleanupAfterCommand();
  }

  // Check fingerprint after execution
  let afterFingerprint: string;
  try {
    afterFingerprint = await captureRepoFingerprint(exec, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode,
      output: `${output}\n\n${FINGERPRINT_MISMATCH_ERROR} Additionally, fingerprint capture after command failed: ${message}`,
      violation: { kind: "fingerprint_mismatch", message: FINGERPRINT_MISMATCH_ERROR },
    };
  }

  if (beforeFingerprint !== afterFingerprint) {
    return {
      exitCode,
      output: `${output}\n\n${FINGERPRINT_MISMATCH_ERROR}\nPlease inspect the repository state manually.`,
      violation: { kind: "fingerprint_mismatch", message: FINGERPRINT_MISMATCH_ERROR },
    };
  }

  return { exitCode, output };
}
