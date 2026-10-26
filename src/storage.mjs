import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

const PROCESS_TOKEN = randomUUID()

export function readJSON(file) {
  try { return JSON.parse(readFileSync(file, "utf8")) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
}

export function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

export function validateId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid task or command id.")
  return id
}

export class Storage {
  constructor(directory, pageFile) {
    this.directory = directory
    this.pageFile = pageFile
    this.instance = randomUUID()
    mkdirSync(join(directory, "tasks"), { recursive: true, mode: 0o700 })
  }
  taskPath(id) { return join(this.directory, "tasks", `${validateId(id)}.json`) }
  get(id) { return readJSON(this.taskPath(id)) }
  put(task) { writeJSON(this.taskPath(task.id), task) }
  tasks() {
    return readdirSync(join(this.directory, "tasks")).filter(f => f.endsWith(".json"))
      .map(f => readJSON(join(this.directory, "tasks", f))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  claim(command) {
    const file = join(this.directory, "commands", `${validateId(command.id)}.json`)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try { writeFileSync(file, JSON.stringify(command), { flag: "wx", mode: 0o600 }); return true }
    catch (error) { if (error.code === "EEXIST") return false; throw error }
  }
  control() { return readJSON(join(this.directory, "control.json")) }
  setControl(control) { writeJSON(join(this.directory, "control.json"), control) }
  lock() {
    const file = join(this.directory, "runner.lock")
    const owner = { pid: process.pid, processToken: PROCESS_TOKEN, instance: this.instance }
    try { writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); return true }
    catch (error) { if (error.code !== "EEXIST") throw error }
    const previous = readJSON(file)
    if (!previous) return false
    if (previous.pid === process.pid && previous.processToken !== PROCESS_TOKEN) {
      // Docker can assign the same PID to Bun after a container restart.
      if (readJSON(file)?.instance === previous.instance) unlinkSync(file)
      return false
    }
    try { process.kill(previous.pid, 0) }
    catch (error) {
      if (error.code !== "ESRCH") throw error
      // A dead Bun host cannot finish its task. The next host takes ownership.
      if (readJSON(file)?.instance === previous.instance) unlinkSync(file)
    }
    return false
  }
  unlock() {
    const file = join(this.directory, "runner.lock")
    if (readJSON(file)?.instance === this.instance) unlinkSync(file)
  }
  publish(state) {
    mkdirSync(dirname(this.pageFile), { recursive: true, mode: 0o700 })
    // This is a page asset, not plugins.json: progress must not reload the host.
    const code = `globalThis.detectorState(${JSON.stringify(state).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")});\n`
    const temporary = `${this.pageFile}.${this.instance}.tmp`
    writeFileSync(temporary, code, { mode: 0o600 })
    renameSync(temporary, this.pageFile)
  }
}
