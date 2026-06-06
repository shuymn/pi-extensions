export const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
  "[hooks]",
  "managed_skills.",
  "CursorPluginsAgentSkillsService load completed",
  "LocalCursorRulesService load completed",
  "AgentSkillsCursorRulesService load completed",
  "Error initializing ignore mapping for",
  "Ripgrep path not configured. Call configureRipgrepPath() at startup.",
];

let activeStartupOutputSuppressions = 0;
let startupOutputOriginals:
  | {
      stdoutWrite: typeof process.stdout.write;
      stderrWrite: typeof process.stderr.write;
      consoleLog: typeof console.log;
      consoleInfo: typeof console.info;
      consoleWarn: typeof console.warn;
      consoleError: typeof console.error;
      consoleDebug: typeof console.debug;
    }
  | undefined;

export function isCursorSdkStartupNoise(text: string): boolean {
  return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}

function createFilteredProcessWrite(
  write: typeof process.stdout.write,
  stream: NodeJS.WriteStream,
): typeof process.stdout.write {
  return ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (isCursorSdkStartupNoise(text)) {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.();
      return true;
    }
    return write.call(stream, chunk, encodingOrCallback as BufferEncoding, callback);
  }) as unknown as typeof process.stdout.write;
}

function createFilteredConsoleMethod<T extends (...args: unknown[]) => void>(method: T): T {
  return ((...args: unknown[]) => {
    const text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
    if (isCursorSdkStartupNoise(text)) return;
    method(...args);
  }) as T;
}

function suppressCursorSdkStartupOutput(): () => void {
  if (activeStartupOutputSuppressions === 0) {
    startupOutputOriginals = {
      stdoutWrite: process.stdout.write,
      stderrWrite: process.stderr.write,
      consoleLog: console.log,
      consoleInfo: console.info,
      consoleWarn: console.warn,
      consoleError: console.error,
      consoleDebug: console.debug,
    };
    process.stdout.write = createFilteredProcessWrite(
      startupOutputOriginals.stdoutWrite,
      process.stdout,
    );
    process.stderr.write = createFilteredProcessWrite(
      startupOutputOriginals.stderrWrite,
      process.stderr,
    );
    console.log = createFilteredConsoleMethod(startupOutputOriginals.consoleLog);
    console.info = createFilteredConsoleMethod(startupOutputOriginals.consoleInfo);
    console.warn = createFilteredConsoleMethod(startupOutputOriginals.consoleWarn);
    console.error = createFilteredConsoleMethod(startupOutputOriginals.consoleError);
    console.debug = createFilteredConsoleMethod(startupOutputOriginals.consoleDebug);
  }
  activeStartupOutputSuppressions += 1;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    activeStartupOutputSuppressions = Math.max(activeStartupOutputSuppressions - 1, 0);
    if (activeStartupOutputSuppressions > 0 || !startupOutputOriginals) return;
    process.stdout.write = startupOutputOriginals.stdoutWrite;
    process.stderr.write = startupOutputOriginals.stderrWrite;
    console.log = startupOutputOriginals.consoleLog;
    console.info = startupOutputOriginals.consoleInfo;
    console.warn = startupOutputOriginals.consoleWarn;
    console.error = startupOutputOriginals.consoleError;
    console.debug = startupOutputOriginals.consoleDebug;
    startupOutputOriginals = undefined;
  };
}

export async function withQuietCursorSdkStartup<T>(operation: () => Promise<T>): Promise<T> {
  const restore = suppressCursorSdkStartupOutput();
  try {
    return await operation();
  } finally {
    restore();
  }
}
