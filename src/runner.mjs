import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loadDetector } from "lmfpd-sdk"
import { connection, detectionOptions, NOTICE, object, redact, redactData } from "./config.mjs"
import { loadCatalog, selectionFrom, selectModels } from "./catalog.mjs"
import { Storage, validateId } from "./storage.mjs"

const ACTIVE = new Set(["queued", "loading", "running", "cancelling"])
const now = () => new Date().toISOString()
const sampleSummary = sample => ({
  state: sample.state, count: sample.count, expected_count: sample.expected_count,
  response_model: sample.response_model, first_byte_ms: sample.first_byte_ms, error: sample.error,
})

export function taskSummary(task, details = false) {
  if (!task) return null
  const { id, status, createdAt, finishedAt, selection, parameters, referenceBuiltAt, error, rows = [] } = task
  return {
    id, status, createdAt, finishedAt, selection, parameters, referenceBuiltAt, error,
    total: rows.length, finished: rows.filter(r => !ACTIVE.has(r.status)).length,
    rows: rows.map(row => ({
      model: row.model, provider: row.provider, round: row.round, api: row.api, status: row.status,
      analysis: row.result?.analysis ?? null, error: row.error ?? row.result?.error ?? null,
      samples: (row.result?.samples ?? row.samples ?? []).map(sampleSummary),
      ...(details ? { result: row.result } : {}),
    })), notice: NOTICE,
  }
}

export class Runner {
  constructor({ directory, pageFile, options = {}, detectorLoader = loadDetector, catalogLoader = loadCatalog, log = console.error }) {
    this.options = options
    this.storage = new Storage(join(directory, "llm-detector"), pageFile)
    this.detectorLoader = detectorLoader
    this.catalogLoader = catalogLoader
    this.log = log
    this.state = { updatedAt: now(), commandId: null, connection: "unconfigured", error: null, catalog: null, task: null, history: [], notice: NOTICE }
    this.owned = false
    this.busy = false
    this.closed = false
    this.controller = new AbortController()
  }

  initialize() {
    const command = this.options.command
    if (command) {
      try { this.accept(command) }
      catch (error) {
        const message = redact(error, this.options.apiKey)
        if (typeof command.id === "string" && /^[a-zA-Z0-9_-]+$/.test(command.id)) {
          if (this.storage.claim({ id: command.id, action: "invalid", createdAt: now() })) {
            this.storage.setControl({ id: command.id, action: "invalid", taskId: null })
          }
          const control = this.storage.control()
          if (control?.id === command.id && control.action === "invalid") this.commandError = message
        } else this.commandError = message
      }
    }
    this.revision = this.storage.control()?.id
    this.timer = setInterval(() => { void this.tick().catch(error => this.fail(error)) }, 1000)
    this.timer.unref?.()
    void this.tick().catch(error => this.fail(error))
    return this
  }

  accept(command) {
    object(command, "command")
    validateId(command.id)
    if (!["refresh", "start", "cancel"].includes(command.action)) throw new Error("Unknown detector command.")
    const createdAt = now()
    let task
    if (command.action === "start") {
      const input = object(command.input ?? {})
      task = {
        id: command.id, createdAt, status: "queued", selection: selectionFrom(input),
        parameters: detectionOptions(input), rows: [], error: null,
      }
    }
    if (command.action === "cancel") validateId(command.taskId)
    if (!this.storage.claim({ id: command.id, action: command.action, createdAt })) return false
    if (task) this.storage.put(task)
    this.storage.setControl({ id: command.id, action: command.action, taskId: task?.id ?? command.taskId ?? null })
    return true
  }

  async tick() {
    if (this.closed) return
    const control = this.storage.control()
    if (control?.id !== this.revision) {
      this.controller.abort()
      if (!this.busy) this.close()
      return
    }
    if (!this.owned) {
      if (!this.storage.lock()) return
      this.owned = true
      this.recover(control)
      this.state.commandId = control?.id ?? null
      this.publish()
      this.busy = true
      this.work = this.run(control).catch(error => this.fail(error)).finally(() => {
        this.busy = false
        if (this.closed || this.controller.signal.aborted) this.close()
      })
    } else this.publish()
  }

  recover(control) {
    for (const task of this.storage.tasks()) {
      if (!ACTIVE.has(task.status)) continue
      if (task.status === "queued" && control?.action === "start" && control.taskId === task.id) continue
      const cancelled = control?.action === "cancel" && control.taskId === task.id
      task.status = cancelled ? "cancelled" : "interrupted"
      task.error = cancelled ? "Cancelled by user." : "Magpie plugin host stopped or reloaded. This task was not resumed."
      task.finishedAt = now()
      for (const row of task.rows) if (ACTIVE.has(row.status)) row.status = task.status
      this.storage.put(task)
    }
  }

  async run(control) {
    if (this.commandError) throw new Error(this.commandError)
    let conn
    try { conn = connection(this.options) }
    catch (error) { this.state.connection = "unconfigured"; throw error }
    this.secret = conn.apiKey
    this.state.connection = "connecting"
    this.publish()
    this.state.catalog = await this.catalogLoader(conn, this.controller.signal)
    this.controller.signal.throwIfAborted()
    this.state.connection = "connected"
    this.state.error = null
    this.publish()
    if (control?.action !== "start") return
    const task = this.storage.get(control.taskId)
    if (!task || task.status !== "queued") return
    await this.execute(task, conn)
  }

  async execute(task, conn) {
    this.current = task
    try {
      const targets = selectModels(this.state.catalog, task.selection)
      const params = task.parameters
      task.rows = targets.flatMap(model => Array.from({ length: params.rounds }, (_, index) => ({
        model: model.id, provider: model.provider, round: index + 1,
        api: params.api === "auto" ? model.api : params.api, status: "queued", samples: [],
      })))
      task.status = "loading"
      this.saveTask(task)
      const detector = await this.detectorLoader({
        cache: join(this.storage.directory, "reference.bin"),
        ...(this.options.dataSource ? { source: this.options.dataSource } : {}),
      })
      this.controller.signal.throwIfAborted()
      task.referenceBuiltAt = detector.builtAt
      task.status = "running"
      this.saveTask(task)
      let next = 0
      const worker = async () => {
        while (!this.controller.signal.aborted && next < task.rows.length) {
          const row = task.rows[next++]
          row.status = "running"
          this.saveTask(task)
          try {
            const result = await detector.detect({ ...conn, ...params, api: row.api, model: row.model }, {
              signal: this.controller.signal,
              onSample: (index, sample) => { row.samples[index] = redactData(sampleSummary(sample), this.secret) },
            })
            row.result = redactData(result, this.secret)
            row.status = this.controller.signal.aborted ? "cancelled" : result.error ? "failed" : "completed"
          } catch (error) {
            row.status = this.controller.signal.aborted ? "cancelled" : "failed"
            row.error = redact(error, this.secret)
          }
          this.saveTask(task)
        }
      }
      await Promise.all(Array.from({ length: Math.min(params.concurrency, task.rows.length) }, worker))
      if (this.controller.signal.aborted) {
        const latest = this.storage.control()
        task.status = latest?.action === "cancel" && latest.taskId === task.id ? "cancelled" : "interrupted"
        for (const row of task.rows) if (ACTIVE.has(row.status) || row.status === "cancelled") row.status = task.status
      } else {
        const failed = task.rows.filter(r => r.status === "failed").length
        task.status = failed === task.rows.length ? "failed" : failed ? "completed_with_errors" : "completed"
      }
    } catch (error) {
      const cancelled = this.storage.control()?.action === "cancel" && this.storage.control()?.taskId === task.id
      task.status = this.controller.signal.aborted ? (cancelled ? "cancelled" : "interrupted") : "failed"
      task.error = redact(error, this.secret)
      for (const row of task.rows) if (ACTIVE.has(row.status)) row.status = task.status
    } finally {
      task.finishedAt = now()
      this.saveTask(task)
      this.current = null
    }
  }

  saveTask(task) {
    this.storage.put(redactData(task, this.secret))
    this.state.task = taskSummary(task)
    this.publish()
  }

  publish() {
    if (!this.owned) return
    const tasks = this.storage.tasks()
    const latest = tasks[0]
    this.state.task = taskSummary(this.current ?? latest)
    this.state.history = tasks.map(t => ({ id: t.id, createdAt: t.createdAt, status: t.status }))
    this.state.updatedAt = now()
    this.storage.publish(redactData(this.state, this.secret))
  }

  fail(error) {
    const message = redact(error, this.secret)
    this.state.error = message
    if (this.state.connection === "connecting") this.state.connection = "failed"
    const control = this.storage.control()
    if (!this.current && control?.id === this.revision && control?.action === "start") {
      const task = this.storage.get(control.taskId)
      if (task?.status === "queued") {
        task.status = "failed"; task.error = message; task.finishedAt = now(); this.storage.put(task)
      }
    }
    try { this.publish() } catch (publishError) { this.log(`llm-detector: ${redact(publishError, this.secret)}`) }
    this.log(`llm-detector: ${message}`)
  }

  async list(signal) {
    const conn = connection(this.options)
    try { return redactData(await this.catalogLoader(conn, signal), conn.apiKey) }
    catch (error) { throw new Error(redact(error, conn.apiKey)) }
  }

  async start(input, signal) {
    if (this.closed || !this.owned || this.storage.control()?.id !== this.revision) throw new Error("Detector host is reloading. Call again after it has loaded.")
    if (this.busy) throw new Error("The detector is busy. Read or cancel the current task first.")
    const selection = selectionFrom(input), parameters = detectionOptions(input)
    const catalog = await this.list(signal)
    const targets = selectModels(catalog, selection)
    signal?.throwIfAborted()
    if (this.closed || this.storage.control()?.id !== this.revision) throw new Error("Detector host is reloading.")
    if (this.busy) throw new Error("Another detection task just started.")
    const task = { id: randomUUID(), createdAt: now(), status: "queued", selection, parameters, rows: [], error: null }
    this.state.error = null
    this.state.connection = "connected"
    this.state.catalog = catalog
    this.storage.put(task)
    this.storage.setControl({ id: this.revision, action: "start", taskId: task.id })
    this.busy = true
    this.controller = new AbortController()
    this.work = this.execute(task, connection(this.options)).catch(error => this.fail(error)).finally(() => {
      this.busy = false
      if (this.closed) this.close()
    })
    return { taskId: task.id, models: targets.length, rounds: parameters.rounds, plannedRequests: targets.length * parameters.rounds * parameters.count, notice: NOTICE }
  }

  get(id, details = false) {
    if (id === undefined) return this.storage.tasks().map(t => taskSummary(t))
    validateId(id)
    const task = this.current?.id === id ? this.current : this.storage.get(id)
    if (!task) throw new Error(`Unknown task: ${id}`)
    return redactData(taskSummary(task, details), this.secret)
  }

  cancel(id) {
    validateId(id)
    const task = this.storage.get(id)
    if (!task) throw new Error(`Unknown task: ${id}`)
    if (!ACTIVE.has(task.status)) return taskSummary(task)
    if (this.current?.id === id) {
      this.storage.setControl({ id: this.revision, action: "cancel", taskId: id })
      this.current.status = "cancelling"
      this.controller.abort()
      this.saveTask(this.current)
      return taskSummary(this.current)
    }
    throw new Error("Task belongs to another host. Wait for the host to finish reloading.")
  }

  close() {
    this.closed = true
    this.controller.abort()
    clearInterval(this.timer)
    if (!this.busy && this.owned) { this.storage.unlock(); this.owned = false }
  }
}
