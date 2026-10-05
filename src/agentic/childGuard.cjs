"use strict";

const limitMs = Number(process.env.FOURLPHA_BAW_LIMIT_MS);
const parentPid = Number(process.env.FOURLPHA_PARENT_PID);
const deadlineMs = Number(process.env.FOURLPHA_START_DEADLINE_MS);
delete process.env.FOURLPHA_BAW_LIMIT_MS;
delete process.env.FOURLPHA_PARENT_PID;
delete process.env.FOURLPHA_START_DEADLINE_MS;

function parentAlive() {
  if (process.ppid !== parentPid) return false;
  if (process.platform === "win32") {
    try { process.kill(parentPid, 0); } catch { return false; }
  }
  return true;
}

if (!Number.isSafeInteger(limitMs) || limitMs <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0
  || !Number.isSafeInteger(deadlineMs) || Date.now() > deadlineMs || !parentAlive()) {
  process.stdout.write('{"fourlphaGuard":"refused-start"}');
  process.exit(75);
}

function kill() { process.kill(process.pid, "SIGKILL"); }
setTimeout(kill, limitMs).unref();
setInterval(() => { if (!parentAlive()) kill(); }, 250).unref();
