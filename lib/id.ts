import { randomBytes } from "node:crypto";
export const newId = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;
