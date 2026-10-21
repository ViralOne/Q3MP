// Bot navigation (.aas) for maps that ship without it.
//
// Bots can only move on maps with a maps/<name>.aas file. For a map that has
// none, the gateway runs bspc (the GPL bot-navigation compiler, bundled in the
// all-in-one image) on the map's .bsp and packs the result as
// zz-aas-<map>.pk3 next to the map's own pk3, where the server picks it up on
// its next start. Jobs run one at a time; bspc needs a few seconds to a few
// minutes per map.
//
// Env:
//   BSPC_PATH   bspc binary (default "bspc" on PATH; missing = feature off)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

const bspcPath = process.env.BSPC_PATH || "bspc";
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const KEEP_JOBS = 30;

export const aasPakName = (map) => `zz-aas-${map}.pk3`;
const SAFE_MAP = /^[\w.-]{1,64}$/;

let bspcAvailable = null;
export function hasBspc() {
  if (bspcAvailable === null) {
    // bspc with no arguments prints its usage and exits
    const probe = spawnSync(bspcPath, [], { stdio: "ignore", timeout: 5000 });
    bspcAvailable = !probe.error;
  }
  return bspcAvailable;
}

// Minimal zip writer (stored entries) — enough for a pk3 holding one .aas.
// The 1980-01-01 timestamp keeps Quake from refusing "future" entries.
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "latin1");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12);            // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const jobs = [];          // newest last: {map, state, queuedAt, startedAt, endedAt, error}
let running = false;

export function aasJobs() {
  return jobs.map(({ map, state, queuedAt, startedAt, endedAt, error }) =>
    ({ map, state, queuedAt, startedAt, endedAt, error }));
}

// Queue generation for `maps` ({name, readBsp: () => Buffer}); maps already
// queued or running are skipped. `dataDir` is where the pk3 lands.
export function queueAas(maps, dataDir, onDone = () => {}) {
  const queued = [];
  for (const m of maps) {
    if (!SAFE_MAP.test(m.name)) continue;
    if (jobs.some((j) => j.map === m.name && (j.state === "queued" || j.state === "running"))) continue;
    jobs.push({ map: m.name, readBsp: m.readBsp, dataDir, onDone, state: "queued", queuedAt: Date.now() });
    queued.push(m.name);
  }
  while (jobs.length > KEEP_JOBS && jobs[0].state !== "queued" && jobs[0].state !== "running") jobs.shift();
  runNext();
  return queued;
}

function runNext() {
  if (running) return;
  const job = jobs.find((j) => j.state === "queued");
  if (!job) return;
  running = true;
  job.state = "running";
  job.startedAt = Date.now();
  let work = null;
  const finish = (error) => {
    job.endedAt = Date.now();
    job.state = error ? "failed" : "done";
    job.error = error ? String(error.message || error) : undefined;
    job.readBsp = null;
    if (work) rmSync(work, { recursive: true, force: true });
    running = false;
    try { job.onDone(job); } catch { /* listener errors never stop the queue */ }
    runNext();
  };
  try {
    work = mkdtempSync(join(tmpdir(), "aas-"));
    const bsp = join(work, `${job.map}.bsp`);
    writeFileSync(bsp, job.readBsp());
    const child = spawn(bspcPath, ["-bsp2aas", bsp, "-forcesidesvisible", "-optimize", "-output", work], {
      cwd: work,
      stdio: "ignore",                         // bspc prints megabytes of progress
      timeout: JOB_TIMEOUT_MS,
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const aas = join(work, `${job.map}.aas`);
      if (code !== 0 || !existsSync(aas)) {
        return finish(new Error(signal ? `bspc stopped (${signal})` : `bspc failed (exit ${code})`));
      }
      try {
        const pk3 = storedZip([{ name: `maps/${job.map}.aas`, data: readFileSync(aas) }]);
        const target = join(job.dataDir, aasPakName(job.map));
        writeFileSync(`${target}.tmp`, pk3);
        renameSync(`${target}.tmp`, target);
        finish(null);
      } catch (error) {
        finish(error);
      }
    });
  } catch (error) {
    finish(error);
  }
}
