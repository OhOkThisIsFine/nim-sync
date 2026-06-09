import crypto from "crypto";
import type { NIMModel } from "../types/index.js";

const hashModels = (models: NIMModel[]): string => {
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify([...models].sort((a, b) => a.id.localeCompare(b.id))),
  );
  return hash.digest("hex");
};

export { hashModels };
