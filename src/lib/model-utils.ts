import type { NIMModel } from "../types/index.js";

function validateAPIResponse(response: unknown): NIMModel[] {
  if (!response || typeof response !== "object")
    throw new Error(
      "Invalid API response: Expected object, got " +
        (response === null ? "null" : typeof response),
    );
  const obj = response as Record<string, unknown>;
  if (!("data" in obj))
    throw new Error(
      "Invalid API response: Missing data field. Keys: [" +
        Object.keys(obj).join(", ") +
        "]",
    );
  const data = obj.data;
  if (!Array.isArray(data))
    throw new Error(
      "Invalid API response: data must be array, got " + typeof data,
    );
  const seenIds = new Set<string>();
  const models: NIMModel[] = [];
  for (let i = 0; i < data.length; i++) {
    const m = data[i] as Record<string, unknown>;
    if (!m || typeof m !== "object")
      throw new Error("Invalid model at index " + i + ": not an object");
    if (typeof m.id !== "string" || m.id.length === 0)
      throw new Error("Invalid model at index " + i + ": invalid id");
    if (seenIds.has(m.id)) throw new Error("Duplicate model ID: " + m.id);
    seenIds.add(m.id);
    models.push({
      id: m.id,
      name:
        typeof m.name === "string" && m.name.length > 0
          ? m.name
          : m.id.split("/").pop()?.replace(/-/g, " ") || m.id,
      object: typeof m.object === "string" ? m.object : undefined,
      created: typeof m.created === "number" ? m.created : undefined,
      owned_by: typeof m.owned_by === "string" ? m.owned_by : undefined,
    });
  }
  return models;
}

export { validateAPIResponse };
