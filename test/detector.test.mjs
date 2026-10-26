import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vm from "node:vm"
import { catalogFrom, selectModels, selectionFrom } from "../src/catalog.mjs"
import { connection, detectionOptions } from "../src/config.mjs"
import { Storage } from "../src/storage.mjs"
import { Runner } from "../src/runner.mjs"

const directories = [], runners = []
afterEach(async () => {
  for (const runner of runners.splice(0)) { runner.close(); await runner.work; runner.close() }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const catalog = catalogFrom({ data: [
  { id: "alpha/vendor/model", owned_by: "alpha", native_endpoints: ["/v1/messages"] },
  { id: "alpha/second", owned_by: "alpha", native_endpoints: ["/v1/responses"] },
  { id: "beta/third", owned_by: "beta" },
  { id: "group/fast", owned_by: "group" },
  { id: "third", owned_by: "beta" },
  { id: "beta/image", owned_by: "beta", modalities: { output: ["image"] } },
] })
const result = (model, probability = null) => ({
  challenges: [], samples: [{ state: "complete", text: "1 2", raw_text: "1 2", count: 2, expected_count: 3, response_model: model, first_byte_ms: 12, error: null }],
  analysis: { decision: "partial", prediction: model, prediction_name: model, probability, used_outputs: 1, results: [] }, error: null,
})
const options = { baseUrl: "http://127.0.0.1:3425/v1", apiKey: 'secret"key' }
function fixture(extra = {}) {
  const directory = extra.directory ?? mkdtempSync(join(tmpdir(), "magpie-detector-unit-"))
  if (!extra.directory) directories.push(directory)
  const pageFile = join(directory, "runtime.js")
  const runner = new Runner({ directory, pageFile, options, catalogLoader: async () => catalog,
    detectorLoader: async () => ({ builtAt: "reference-build", detect: async config => result(config.model) }), log() {}, ...extra })
  runners.push(runner)
  return runner
}
async function ready(runner) {
  runner.initialize()
  await runner.work
  return runner
}
function pageState(runner) {
  let state
  vm.runInNewContext(readFileSync(runner.storage.pageFile, "utf8"), { detectorState: value => { state = value } })
  return state
}

describe("model selection and configuration", () => {
  test("unions multiple providers and exact slash-containing model IDs without duplicates", () => {
    const selected = selectModels(catalog, selectionFrom({ providers: ["alpha"], models: ["alpha/vendor/model", "beta/third"] }))
    expect(selected.map(m => m.id)).toEqual(["alpha/second", "alpha/vendor/model", "beta/third"])
    expect(selected.map(m => m.api)).toEqual(["responses", "messages", "chat_completions"])
    expect(selectModels(catalog, selectionFrom({ all: true }))).toHaveLength(3)
    expect(catalog.skipped.map(m => m.reason)).toEqual(["routing_group", "bare_alias", "not_text_generation"])
  })
  test("rejects unavailable models and empty or ambiguous selections before sending challenges", () => {
    expect(() => selectModels(catalog, selectionFrom({ models: ["missing/model"] }))).toThrow("not available")
    expect(() => selectionFrom({})).toThrow("Select at least")
    expect(() => selectionFrom({ all: true, providers: ["alpha"] })).toThrow("not both")
    expect(() => selectionFrom({ providers: "alpha" })).toThrow("array")
    expect(() => detectionOptions({ count: 1, strict: true })).toThrow("strict requires count 3")
    expect(() => detectionOptions({ concurrency: 0 })).toThrow("positive integer")
  })
  test("uses a configured environment key and rejects endpoint or credential-bearing URLs", () => {
    expect(connection({ baseUrl: "https://example.com", apiKeyEnv: "DETECTOR_KEY" }, { DETECTOR_KEY: "abc" })).toEqual({ baseUrl: "https://example.com/v1", apiKey: "abc" })
    expect(() => connection({ ...options, baseUrl: "https://example.com/v1/messages" })).toThrow("API base")
    expect(() => connection({ ...options, baseUrl: "https://user:pass@example.com" })).toThrow("without credentials")
    expect(() => connection({}, {})).toThrow("gateway key")
  })
})

describe("durable detection tasks", () => {
  test("runs requested rounds, preserves partial probability, and loads reference data once per batch", async () => {
    let loads = 0
    const calls = []
    const runner = await ready(fixture({ detectorLoader: async () => {
      loads++
      return { builtAt: "build-1", async detect(config, { signal, onSample }) {
        calls.push(config)
        expect(signal).toBeInstanceOf(AbortSignal)
        onSample(0, { state: "streaming", count: 1, expected_count: 300 })
        return result(config.model)
      } }
    } }))
    const started = await runner.start({ providers: ["alpha"], rounds: 2, count: 1 })
    await runner.work
    const task = runner.get(started.taskId)
    expect(task.status).toBe("completed")
    expect(task.rows).toHaveLength(4)
    expect(task.rows.every(row => row.analysis.probability === null)).toBe(true)
    expect(loads).toBe(1)
    expect(calls.every(call => call.baseUrl === options.baseUrl && call.apiKey === options.apiKey)).toBe(true)
    expect(started.plannedRequests).toBe(4)
    expect(pageState(runner).task.id).toBe(started.taskId)
  })
  test("one model failure does not stop other models, and secrets never reach saved results or page assets", async () => {
    const runner = await ready(fixture({ detectorLoader: async () => ({ builtAt: "b", async detect(config) {
      if (config.model === "alpha/second") throw new Error(`upstream echoed ${options.apiKey}`)
      const out = result(config.model)
      out.samples[0].raw_text = `reply ${options.apiKey}`
      return out
    } }) }))
    const started = await runner.start({ all: true })
    await runner.work
    expect(runner.get(started.taskId).status).toBe("completed_with_errors")
    expect(readFileSync(runner.storage.taskPath(started.taskId), "utf8")).not.toContain("secret")
    expect(readFileSync(runner.storage.pageFile, "utf8")).not.toContain("secret")
    expect(runner.get(started.taskId).rows[0].error).toContain("[REDACTED]")
  })
  test("cancels in-flight SDK requests and does not start queued models", async () => {
    let startedRequest
    const requested = new Promise(resolve => { startedRequest = resolve })
    let calls = 0
    const runner = await ready(fixture({ detectorLoader: async () => ({ builtAt: "b", detect(_config, { signal }) {
      calls++; startedRequest()
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ challenges: [], samples: [], analysis: null, error: "Cancelled." }), { once: true }))
    } }) }))
    const task = await runner.start({ all: true })
    await requested
    expect(runner.cancel(task.taskId).status).toBe("cancelling")
    await runner.work
    expect(calls).toBe(1)
    expect(runner.get(task.taskId).status).toBe("cancelled")
    expect(runner.get(task.taskId).rows.every(row => row.status === "cancelled")).toBe(true)
  })
  test("page commands are executed once across host reloads", async () => {
    let calls = 0
    const command = { id: "page-command-1", action: "start", input: { models: ["beta/third"] } }
    const loader = async () => ({ builtAt: "b", detect: async config => { calls++; return result(config.model) } })
    const first = await ready(fixture({ options: { ...options, command }, detectorLoader: loader }))
    expect(first.get(command.id).status).toBe("completed")
    first.close()
    const second = await ready(fixture({ directory: first.storage.directory.replace(/\/llm-detector$/, ""), options: { ...options, command }, detectorLoader: loader }))
    expect(second.get(command.id).status).toBe("completed")
    expect(calls).toBe(1)
  })
  test("host recovery marks a started task interrupted without replaying challenges", async () => {
    let calls = 0
    const first = fixture()
    first.storage.put({ id: "interrupted-task", createdAt: new Date().toISOString(), status: "running", rows: [
      { model: "alpha/second", round: 1, status: "completed", result: result("alpha/second") },
      { model: "beta/third", round: 1, status: "running" },
    ] })
    first.storage.setControl({ id: "interrupted-task", action: "start", taskId: "interrupted-task" })
    const runner = await ready(fixture({ directory: first.storage.directory.replace(/\/llm-detector$/, ""), detectorLoader: async () => { calls++; throw new Error("should not load") } }))
    const task = runner.get("interrupted-task")
    expect(task.status).toBe("interrupted")
    expect(task.rows[0].status).toBe("completed")
    expect(task.rows[1].status).toBe("interrupted")
    expect(calls).toBe(0)
  })
  test("only one host owns a runner, and a page cancellation hands ownership to the new host", async () => {
    let requested
    const requestStarted = new Promise(resolve => { requested = resolve })
    const first = await ready(fixture({ detectorLoader: async () => ({ builtAt: "b", detect(_config, { signal }) {
      requested()
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ samples: [], analysis: null, error: "Cancelled." }), { once: true }))
    } }) }))
    const task = await first.start({ models: ["beta/third"] })
    await requestStarted
    const second = fixture({ directory: first.storage.directory.replace(/\/llm-detector$/, ""), options: { ...options, command: { id: "cancel-command", action: "cancel", taskId: task.taskId } } })
    second.initialize()
    expect(second.owned).toBe(false)
    await first.tick()
    await first.work
    await first.tick()
    await second.tick()
    await second.work
    expect(second.owned).toBe(true)
    expect(second.get(task.taskId).status).toBe("cancelled")
  })
  test("reports an invalid page command without breaking plugin loading", async () => {
    const runner = await ready(fixture({ options: { ...options, command: { id: "invalid-page-command", action: "start", input: { all: true, count: 1, strict: true } } } }))
    expect(pageState(runner).commandId).toBe("invalid-page-command")
    expect(pageState(runner).error).toContain("strict requires count 3")
    expect(runner.storage.tasks()).toHaveLength(0)
  })
  test("replaying an invalid page command does not replace a newer command or its error state", async () => {
    const command = { id: "invalid-command", action: "start", input: { all: true, count: 1, strict: true } }
    const first = await ready(fixture({ options: { ...options, command } }))
    const directory = first.storage.directory.replace(/\/llm-detector$/, "")
    first.close()
    const refreshed = await ready(fixture({ directory, options: { ...options, command: { id: "newer-refresh", action: "refresh" } } }))
    expect(pageState(refreshed).commandId).toBe("newer-refresh")
    refreshed.close()
    const replayed = await ready(fixture({ directory, options: { ...options, command } }))
    expect(pageState(replayed).commandId).toBe("newer-refresh")
    expect(pageState(replayed).connection).toBe("connected")
    expect(pageState(replayed).error).toBeNull()
    expect(replayed.storage.tasks()).toHaveLength(0)
  })
  test("catalog tool redacts a key echoed in returned data without changing the source catalog", async () => {
    const source = structuredClone(catalog)
    source.models[0].name = `Model ${options.apiKey}`
    source.skipped.push({ id: "unknown", reason: `echo ${options.apiKey}` })
    const runner = fixture({ catalogLoader: async () => source })
    const listed = await runner.list()
    expect(listed.models[0].name).toBe("Model [REDACTED]")
    expect(listed.skipped.at(-1).reason).toBe("echo [REDACTED]")
    expect(listed.models[0].id).toBe(source.models[0].id)
    expect(source.models[0].name).toBe(`Model ${options.apiKey}`)
  })
  test("catalog tool redacts a key echoed in an error returned to the Agent", async () => {
    const runner = fixture({ catalogLoader: async () => { throw new Error(`Catalog refused ${options.apiKey}`) } })
    await expect(runner.list()).rejects.toThrow("Catalog refused [REDACTED]")
  })
  test("starting a task after catalog recovery clears the old page error immediately", async () => {
    let unavailable = true
    const runner = await ready(fixture({ catalogLoader: async () => {
      if (unavailable) throw new Error("Catalog temporarily unavailable")
      return catalog
    } }))
    expect(pageState(runner).connection).toBe("failed")
    expect(pageState(runner).error).toBe("Catalog temporarily unavailable")
    unavailable = false
    const started = await runner.start({ models: ["beta/third"] })
    const state = pageState(runner)
    expect(state.error).toBeNull()
    expect(state.connection).toBe("connected")
    expect(state.task.id).toBe(started.taskId)
    await runner.work
    expect(runner.get(started.taskId).status).toBe("completed")
  })
  test("a reused Docker PID does not leave the next host locked out", () => {
    const runner = fixture()
    const lock = join(runner.storage.directory, "runner.lock")
    writeFileSync(lock, JSON.stringify({ pid: process.pid, processToken: "previous-container", instance: "old" }))
    expect(runner.storage.lock()).toBe(false)
    expect(runner.storage.lock()).toBe(true)
    const another = new Storage(runner.storage.directory, runner.storage.pageFile)
    expect(another.lock()).toBe(false)
    runner.storage.unlock()
  })
  test("generated page scripts encode untrusted model names as data", async () => {
    const runner = await ready(fixture())
    runner.state.catalog.models[0].name = '</script><script>alert("x")</script>\u2028'
    runner.publish()
    const script = readFileSync(runner.storage.pageFile, "utf8")
    expect(script).not.toContain("</script>")
    expect(pageState(runner).catalog.models[0].name).toContain("</script>")
  })
})
