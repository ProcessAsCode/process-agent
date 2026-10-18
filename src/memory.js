// Working memory: a small JSON store for runs (process sessions the agent
// started), human tasks, and notes. It holds operational state only — never
// process logic, which lives in the UAPF packages.

import fs from "node:fs";
import crypto from "node:crypto";

export function createMemory(file) {
  let state = { runs: [], tasks: {}, notes: [] };
  if (fs.existsSync(file)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      /* start empty on a corrupt file; the audit log is the record of truth */
    }
  }

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

  return {
    id,
    addRun(run) {
      state.runs.unshift(run);
      state.runs = state.runs.slice(0, 500);
      save();
      return run;
    },
    updateRun(runId, patch) {
      const r = state.runs.find((x) => x.runId === runId);
      if (r) Object.assign(r, patch);
      save();
      return r;
    },
    runs: () => state.runs,
    run: (runId) => state.runs.find((x) => x.runId === runId),
    putTask(task) {
      state.tasks[task.taskInstanceId] = task;
      save();
      return task;
    },
    task: (taskId) => state.tasks[taskId],
    tasks: (filter = {}) =>
      Object.values(state.tasks).filter((t) => !filter.state || t.state === filter.state),
    addNote(note) {
      state.notes.unshift({ at: new Date().toISOString(), ...note });
      state.notes = state.notes.slice(0, 1000);
      save();
    },
    notes: () => state.notes,
  };
}
