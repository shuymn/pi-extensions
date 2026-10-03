import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { safeRepositoryPath } from "./authorization";

/** Restrict the mutating child to the exact files whose review the user authorized. */
export function createReviewMutationTools(cwd: string, files: readonly string[]): ToolDefinition[] {
  const allowed = new Set(files.map(safeRepositoryPath));
  const guard = async (path: string) => {
    const root = await realpath(cwd);
    const target = safeRepositoryPath(relative(resolve(cwd), resolve(cwd, path)));
    if (!allowed.has(target))
      throw new Error(`Review fix cannot modify an unreviewed file: ${path}`);
    const absolute = resolve(root, target);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Review fix requires a regular, unlinked file: ${path}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    // Missing deleted files may be recreated, but symlinked ancestors are never followed.
    let existing = absolute;
    while (true) {
      try {
        if ((await realpath(existing)) !== existing) {
          throw new Error(`Review fix cannot follow a symlink: ${path}`);
        }
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        existing = dirname(existing);
      }
    }
    return absolute;
  };
  // Native tools normalize @, ~ and Unicode spaces before invoking operations.
  // Guard that final I/O path, inside the native file-mutation queue, not params.path.
  const edit = createEditToolDefinition(cwd, {
    operations: {
      access: async (path) => access(await guard(path), constants.R_OK | constants.W_OK),
      readFile: async (path) => readFile(await guard(path)),
      writeFile: async (path, content) => writeFile(await guard(path), content, "utf8"),
    },
  });
  const write = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: async () => {
        // Defer directory creation until the complete target has been authorized.
      },
      writeFile: async (path, content) => {
        const target = await guard(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(await guard(path), content, "utf8");
      },
    },
  });
  // Erase heterogeneous parameter/render types only at the SDK registry boundary.
  return [edit as ToolDefinition, write as ToolDefinition];
}
