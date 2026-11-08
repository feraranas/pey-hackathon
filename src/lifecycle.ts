import lockfile from "proper-lockfile";
import { join } from "node:path";

export function lockDataDirectory(
  directory: string,
  onCompromised?: (error: Error) => void,
) {
  return lockfile.lock(join(directory, ".service"), {
    realpath: false,
    retries: 0,
    stale: 30000,
    update: 10000,
    ...(onCompromised ? { onCompromised } : {}),
  });
}
