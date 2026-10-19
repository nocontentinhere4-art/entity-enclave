// Kill switch: an operator pauses the entity by writing {paused, since} into the pause file.
// Fail-safe: if the file is present but unreadable, the entity pauses itself — better stopped than unattended.
import { readFileSync } from 'node:fs';

export async function paused(config) {
  // No switch configured is NOT "free to act": we fail closed and say why.
  if (!config?.pauseFile) return { paused: true, reason: 'no pause source configured' };
  try {
    const p = JSON.parse(readFileSync(config.pauseFile, 'utf8'));
    return { paused: p.paused === true, ...(p.reason ? { reason: p.reason } : {}) };
  } catch {
    return { paused: true, reason: 'fail-safe' };
  }
}
