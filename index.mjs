import { fileURLToPath } from "node:url"
import { Runner } from "./src/runner.mjs"
import { object } from "./src/config.mjs"

const listOfStrings = { type: "array", items: { type: "string" }, uniqueItems: true }
const selection = {
  models: { ...listOfStrings, description: "Exact provider/model ids returned by list_models." },
  providers: { ...listOfStrings, description: "Provider ids; includes every available text model from these providers." },
  all: { type: "boolean", description: "Select all available provider models. Cannot be combined with models/providers." },
}
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })

export default {
  id: "magpie-llm-detector",
  async server({ directory }, options = {}) {
    const runner = new Runner({ directory, options, pageFile: fileURLToPath(new URL("./page/generated/state.js", import.meta.url)) }).initialize()
    return {
      tool: {
        list_models: {
          description: "List Magpie provider models available to the detector's configured gateway key. Does not send model challenges. Routing groups and non-text models are excluded.",
          args: schema({}),
          async execute(_args, ctx) { return runner.list(ctx.abort) },
        },
        start_detection: {
          description: "Start fingerprint detection using lmfpd-sdk. Select models, providers, or all. Sends billable model challenges (3 per model/round by default). Returns a task ID immediately; poll get_detection. Use only when the user asks to run a detection. Results are closed-set similarity rankings, not identity proof.",
          args: schema({
            ...selection,
            rounds: { type: "integer", minimum: 1, default: 1 },
            concurrency: { type: "integer", minimum: 1, default: 1, description: "Concurrent model rounds; each round sends parallel challenges." },
            count: { type: "integer", minimum: 1, maximum: 3, default: 3 },
            parallel: { type: "integer", minimum: 1, maximum: 3, default: 3 },
            strict: { type: "boolean", default: false },
            api: { type: "string", enum: ["auto", "chat_completions", "responses", "messages"], default: "auto" },
            stream: { type: "boolean", default: true },
            timeout: { type: "number", minimum: 0, default: 120, description: "SDK first-byte timeout in seconds; 0 disables it." },
            effort: { type: "string" },
            serviceTier: { type: "string", enum: ["default", "flex", "fast", "ultrafast"], default: "default" },
          }),
          async execute(args, ctx) { return runner.start(object(args), ctx.abort) },
        },
        get_detection: {
          description: "Read fingerprint task progress and results. With no taskId, lists saved tasks. details includes raw challenge replies for a single task. A failed/interrupted task is never automatically retried.",
          args: schema({ taskId: { type: "string" }, details: { type: "boolean", default: false } }),
          async execute(args) {
            object(args)
            if (args.details !== undefined && typeof args.details !== "boolean") throw new Error("details must be a boolean.")
            return runner.get(args.taskId, args.details)
          },
        },
        cancel_detection: {
          description: "Cancel a running fingerprint task. Stops SDK requests and unsent challenges. Completed results remain saved.",
          args: schema({ taskId: { type: "string" } }, ["taskId"]),
          async execute(args) { return runner.cancel(object(args).taskId) },
        },
      },
    }
  },
}
