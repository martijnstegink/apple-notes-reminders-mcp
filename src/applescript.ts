import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 256 * 1024 * 1024;

// Runs an AppleScript via `osascript -e <script> <args...>`. The script must
// define `on run argv ... end run` and reference dynamic values as
// `item N of argv` — never splice user content into the script text itself,
// since argv values reach AppleScript as literal strings with no quoting,
// escaping, or truncation surprises.
export async function runAppleScript(
  script: string,
  args: string[] = [],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
  });
  return stdout.trim();
}
