import fs from "node:fs";
import path from "node:path";

for (const dir of ["dist"]) {
  const target = path.resolve(dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
