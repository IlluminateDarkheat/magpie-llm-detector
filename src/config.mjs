import { buildRequest } from "lmfpd-sdk"

export const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"
export const NOTICE = "Fingerprint 是参考库内的相似度排名，不能证明模型身份；probability 只比较库内候选。Magpie 的 routing、fallback 和 middleware 仍会影响实际回答。"

export function object(value, name = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`)
  return value
}

export function strings(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) {
    throw new Error(`${name} must be an array of non-empty strings.`)
  }
  return [...new Set(value.map(v => v.trim()))]
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}

export function connection(options, env = process.env) {
  object(options, "plugin options")
  const base = options.baseUrl ?? DEFAULT_BASE_URL
  if (typeof base !== "string") throw new Error("baseUrl must be an HTTP or HTTPS URL.")
  const url = new URL(base)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl must use HTTP or HTTPS without credentials, query or fragment.")
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1"
  if (/\/(chat\/completions|responses|messages)$/.test(url.pathname)) {
    throw new Error("baseUrl must be the API base, such as http://127.0.0.1:3425/v1, not a completion endpoint.")
  }
  const apiKey = options.apiKey || env[options.apiKeyEnv || "MAGPIE_DETECTOR_API_KEY"]
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("请在 plugin 页面填写 Magpie gateway key，或配置 apiKeyEnv 对应的环境变量。")
  }
  return { baseUrl: url.href.replace(/\/$/, ""), apiKey: apiKey.trim() }
}

export function detectionOptions(input = {}) {
  object(input)
  const params = {
    api: input.api ?? "auto",
    rounds: input.rounds ?? 1,
    concurrency: input.concurrency ?? 1,
    count: input.count ?? 3,
    parallel: input.parallel ?? 3,
    strict: input.strict ?? false,
    stream: input.stream ?? true,
    timeout: input.timeout ?? 120,
    effort: input.effort ?? "",
    serviceTier: input.serviceTier ?? "default",
  }
  positiveInteger(params.rounds, "rounds")
  positiveInteger(params.concurrency, "concurrency")
  for (const name of ["strict", "stream"]) {
    if (typeof params[name] !== "boolean") throw new Error(`${name} must be a boolean.`)
  }
  if (typeof params.effort !== "string") throw new Error("effort must be a string.")
  const request = buildRequest({
    ...params, api: params.api === "auto" ? "chat_completions" : params.api,
    baseUrl: DEFAULT_BASE_URL, apiKey: "validation", model: "validation/model",
  }, "validate")
  if ("error" in request) throw new Error(request.error)
  return params
}

export function redact(value, secret) {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value)
  return secret ? text.replaceAll(secret, "[REDACTED]") : text
}

export function redactData(value, secret) {
  if (typeof value === "string") return redact(value, secret)
  if (Array.isArray(value)) return value.map(item => redactData(item, secret))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactData(item, secret)]))
  return value
}
