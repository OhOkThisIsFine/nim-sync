import fs from "fs/promises";
import {
  applyEdits,
  modify as modifyJSONC,
  parse as parseJSONC,
} from "jsonc-parser/lib/esm/main.js";
import type { AtomicWriteOptions } from "./atomic-io.js";
import { atomicWrite } from "./atomic-io.js";

export async function readJSONC<T = unknown>(
  filePath: string,
  validate?: (data: unknown) => data is T,
): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const errors: { error: number; offset: number; length: number }[] = [];
    const result = parseJSONC(content, errors);

    if (errors.length > 0) {
      const errorDetails = errors
        .map((e) => `Parse error code ${e.error} at offset ${e.offset}`)
        .join("; ");
      throw new Error(`JSONC parse errors in ${filePath}: ${errorDetails}`);
    }

    if (validate && !validate(result)) {
      throw new Error(`Invalid data structure in ${filePath}`);
    }

    return result as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {} as T;
    }
    throw error;
  }
}

export async function writeJSONC<T = unknown>(
  filePath: string,
  data: T,
  options?: AtomicWriteOptions,
): Promise<void> {
  let content: string;
  try {
    const existingContent = await fs.readFile(filePath, "utf-8");
    const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
    const formattingOptions = {
      insertSpaces: true,
      tabSize: 2,
      eol,
    };

    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      let updated = existingContent;
      for (const [key, value] of Object.entries(
        data as Record<string, unknown>,
      )) {
        const edits = modifyJSONC(updated, [key], value, { formattingOptions });
        updated = applyEdits(updated, edits);
      }
      content = updated;
    } else {
      content = JSON.stringify(data, null, 2);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    content = JSON.stringify(data, null, 2);
  }
  await atomicWrite(filePath, content, options);
}

export async function updateJSONCPath<T = unknown>(
  filePath: string,
  jsonPath: Array<string | number>,
  data: T,
  options?: AtomicWriteOptions,
): Promise<void> {
  let existingContent = "";

  try {
    existingContent = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const edits = modifyJSONC(existingContent, jsonPath, data, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol,
    },
  });
  const updatedContent = applyEdits(existingContent, edits);

  await atomicWrite(filePath, updatedContent, options);
}

export async function updateJSONCPaths(
  filePath: string,
  updates: Array<{
    jsonPath: Array<string | number>;
    data: unknown;
  }>,
  options?: AtomicWriteOptions,
): Promise<void> {
  let existingContent = "";

  try {
    existingContent = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
  let updatedContent = existingContent;

  for (const update of updates) {
    const edits = modifyJSONC(updatedContent, update.jsonPath, update.data, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol,
      },
    });
    updatedContent = applyEdits(updatedContent, edits);
  }

  await atomicWrite(filePath, updatedContent, options);
}
