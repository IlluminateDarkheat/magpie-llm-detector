import { object, strings, redact } from "./config.mjs"

const ENDPOINTS = {
  "/v1/messages": "messages",
  "/v1/responses": "responses",
  "/v1/chat/completions": "chat_completions",
}

export function catalogFrom(data) {
  if (!Array.isArray(data?.data)) throw new Error("Magpie /models did not return a data array.")
  const models = [], skipped = [], seen = new Set()
  for (const row of data.data) {
    if (typeof row?.id !== "string" || typeof row.owned_by !== "string") {
      throw new Error("Magpie /models returned a model without id or owned_by.")
    }
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const localId = row.id.slice(row.owned_by.length + 1)
    let reason
    if (["group", "auto"].includes(row.owned_by) || /^(group|auto)\//.test(localId)) reason = "routing_group"
    else if (!row.id.startsWith(`${row.owned_by}/`)) reason = "bare_alias"
    else if (row.kind === "decision" || (Array.isArray(row.modalities?.output) && !row.modalities.output.includes("text"))) reason = "not_text_generation"
    if (reason) {
      skipped.push({ id: row.id, reason })
      continue
    }
    models.push({
      id: row.id, name: row.display_name || row.id, provider: row.owned_by,
      api: (row.native_endpoints ?? []).map(p => ENDPOINTS[p]).find(Boolean) ?? "chat_completions",
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  const providers = [...new Set(models.map(m => m.provider))].map(id => ({
    id, models: models.filter(m => m.provider === id).map(m => m.id),
  }))
  return { models, providers, skipped }
}

export async function loadCatalog(connection, signal) {
  const response = await fetch(`${connection.baseUrl}/models`, {
    headers: { authorization: `Bearer ${connection.apiKey}` }, signal, redirect: "error",
  })
  if (!response.ok) {
    throw new Error(`Magpie /models: HTTP ${response.status}: ${redact(await response.text(), connection.apiKey)}`)
  }
  return catalogFrom(await response.json())
}

export function selectionFrom(input) {
  object(input)
  if (input.all !== undefined && typeof input.all !== "boolean") throw new Error("all must be a boolean.")
  const selection = { all: input.all ?? false, models: strings(input.models, "models"), providers: strings(input.providers, "providers") }
  if (selection.all && (selection.models.length || selection.providers.length)) throw new Error("Use all or models/providers, not both.")
  if (!selection.all && !selection.models.length && !selection.providers.length) throw new Error("Select at least one model or provider, or set all: true.")
  return selection
}

export function selectModels(catalog, selection) {
  const modelIds = new Set(catalog.models.map(m => m.id))
  const providerIds = new Set(catalog.providers.map(p => p.id))
  const missingModels = selection.models.filter(id => !modelIds.has(id))
  const missingProviders = selection.providers.filter(id => !providerIds.has(id))
  if (missingModels.length || missingProviders.length) {
    throw new Error(`Selection is not available from this gateway key: ${[...missingModels, ...missingProviders].join(", ")}`)
  }
  const selected = catalog.models.filter(m => selection.all || selection.models.includes(m.id) || selection.providers.includes(m.provider))
  if (!selected.length) throw new Error("No text generation models are available for this selection.")
  return selected
}
