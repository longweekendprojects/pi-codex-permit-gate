import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_HOST = "127.0.0.1";

function localAuthDirectory() {
  const home = os.homedir();
  const agent = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, () => home) || path.join(home, ".pi", "agent");
  return path.join(agent, "codex-permit-gate");
}

function readToken(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 64 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) return undefined;
    const bytes = Buffer.alloc(64);
    if (fs.readSync(fd, bytes) !== bytes.length) return undefined;
    const token = bytes.toString("utf8");
    return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function localAuthorization() {
  const token = readToken(path.join(localAuthDirectory(), "local-token"));
  return token ? `Bearer ${token}` : undefined;
}

function createToken(file) {
  try { fs.lstatSync(file); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    // All lanes share one token. Publish a complete file without replacing a concurrent winner.
    try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function localRequestGuard() {
  const directory = localAuthDirectory();
  const tokenFile = path.join(directory, "local-token");
  const switchFile = path.join(directory, "require-local-token.on");
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    createToken(tokenFile);
  } catch {
    process.stderr.write("Could not create the local permit token. Check the agent directory before enabling local token enforcement.\n");
  }

  return (req) => {
    const { host, origin, "content-type": contentType, authorization } = req.headersDistinct;
    const port = req.socket.localPort;
    if (host?.length !== 1 || (host[0] !== `${LOCAL_HOST}:${port}` && !(port === 80 && host[0] === LOCAL_HOST))) {
      return { status: 400, message: "Host must match the local listener" };
    }
    if (origin !== undefined) return { status: 403, message: "Origin is not allowed" };
    if (req.method !== "POST") return undefined;
    if (contentType?.length !== 1 || contentType[0] !== "application/json") {
      return { status: 415, message: "Control requests require application/json" };
    }
    // Check the switch at admission so rollback needs no restart. Only absence means off.
    try { fs.lstatSync(switchFile); } catch (error) {
      if (error.code === "ENOENT") return undefined;
      return { status: 503, message: "Local token switch is unavailable" };
    }
    const presented = authorization?.length === 1 && authorization[0].match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (!presented) return { status: 401, message: "Local permit token required" };
    const token = readToken(tokenFile);
    if (!token) return { status: 503, message: "Local permit token is unavailable" };
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(token))) return { status: 401, message: "Local permit token required" };
    return undefined;
  };
}
