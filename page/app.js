(async () => {
  const $ = id => document.getElementById(id)
  const active = new Set(["queued", "loading", "running", "cancelling"])
  const labels = {
    queued: "排队中", loading: "加载参考数据", running: "检测中", cancelling: "正在取消", completed: "已完成",
    completed_with_errors: "部分失败", failed: "失败", interrupted: "已中断", cancelled: "已取消",
    scored: "完整评分", partial: "部分评分", not_model: "不像 LLM 回答", unscorable: "无法评分",
    unconfigured: "未配置", connecting: "正在连接", connected: "已连接", complete: "有效", truncated: "已截断",
    waiting: "等待回答", streaming: "接收中",
  }
  const text = (tag, value, className) => {
    const element = document.createElement(tag)
    element.textContent = value
    if (className) element.className = className
    return element
  }
  let options = {}, state = null, busy = false, pending = null, lastWrite = 0, actionProvider = null
  const models = new Set(), providers = new Set()
  const scope = () => document.querySelector('input[name="scope"]:checked').value
  const catalog = () => state?.catalog ?? { models: [], providers: [] }
  const selected = () => catalog().models.filter(m => scope() === "all" || (scope() === "providers" ? providers.has(m.provider) : models.has(m.id)))
  const probability = value => value == null ? "不可用" : `${(value * 100).toFixed(1)}%`
  const showError = message => { $("error").hidden = !message; $("error").textContent = message || "" }

  function repaintSelection() {
    const kind = scope(), query = $("search").value.trim().toLowerCase()
    $("picker-tools").hidden = kind === "all"
    $("targets").hidden = kind === "all"
    const rows = kind === "providers" ? catalog().providers : catalog().models
    const set = kind === "providers" ? providers : models
    $("targets").replaceChildren(...rows.filter(row => `${row.id} ${row.name ?? ""}`.toLowerCase().includes(query)).map(row => {
      const label = document.createElement("label")
      label.className = "target"
      const check = document.createElement("input")
      check.type = "checkbox"; check.checked = set.has(row.id); check.disabled = busy
      check.onchange = () => { check.checked ? set.add(row.id) : set.delete(row.id); counts() }
      const name = document.createElement("span"); name.className = "name"
      name.append(text("strong", row.name || row.id), text("small", kind === "providers" ? `${row.models.length} 个模型` : row.id, "muted"))
      label.append(check, name)
      return label
    }))
    if (!rows.length) $("targets").append(text("p", "尚未读取到模型。请填写 API 设置并保存。", "muted"))
    counts()
  }

  function counts() {
    const count = selected().length
    $("selection-count").textContent = `已选 ${count} 个模型 · ${catalog().providers.length} 个可用 provider`
    $("request-count").textContent = `预计 ${count * Number($("rounds").value) * Number($("count").value)} 次 challenge 请求`
    $("start").disabled = busy || !!pending || count === 0
    for (const id of ["save", "refresh"]) $(id).disabled = busy || !!pending
    $("cancel").hidden = !active.has(state?.task?.status)
    $("cancel").disabled = !!pending || state?.task?.status === "cancelling"
    document.querySelectorAll("#targets input").forEach(input => { input.disabled = busy || !!pending })
  }

  function renderResults() {
    const task = state?.task
    $("progress").textContent = task ? `${labels[task.status] || task.status} · ${task.finished}/${task.total} rounds · ${task.id}` : "尚未开始检测。"
    $("progress-bar").hidden = !task
    $("progress-bar").max = task?.total || 1
    $("progress-bar").value = task?.finished || 0
    $("reference").textContent = task?.referenceBuiltAt ? `Reference build：${task.referenceBuiltAt}` : ""
    $("results").replaceChildren(...(task?.rows ?? []).map(row => {
      const box = document.createElement("details"); box.className = "result"
      const summary = document.createElement("summary")
      summary.append(text("span", `${row.model} · round ${row.round}`), text("span", labels[row.status] || row.status, "badge"))
      box.append(summary)
      const analysis = row.analysis
      if (analysis) {
        box.append(text("p", analysis.prediction_name || analysis.prediction || labels[analysis.decision], "prediction"))
        box.append(text("p", `${labels[analysis.decision] || analysis.decision} · probability ${probability(analysis.probability)} · ${analysis.used_outputs} 条有效回答`, "muted"))
        const table = document.createElement("table")
        const head = document.createElement("tr")
        for (const name of ["候选", "Family", "Ranking score", "Probability"]) head.append(text("th", name))
        const thead = document.createElement("thead"); thead.append(head); table.append(thead)
        const body = document.createElement("tbody")
        for (const candidate of analysis.results) {
          const tr = document.createElement("tr")
          for (const value of [candidate.display_name, candidate.family_name, candidate.score.toFixed(4), probability(candidate.probability)]) tr.append(text("td", value))
          body.append(tr)
        }
        table.append(body); box.append(table)
      }
      if (row.error) box.append(text("p", row.error, "error"))
      for (const [index, sample] of row.samples.entries()) {
        if (!sample) continue
        box.append(text("p", `Sample ${index + 1}：${labels[sample.state] || sample.state} · ${sample.count}/${sample.expected_count} integers${sample.response_model ? ` · response model: ${sample.response_model}` : ""}${sample.error ? ` · ${sample.error}` : ""}`, "muted"))
      }
      return box
    }))
    $("json-box").hidden = !task
    $("json").value = task ? JSON.stringify(task, null, 2) : ""
    $("history").textContent = state?.history?.length ? `已保存 ${state.history.length} 个任务。历史详情可通过 get_detection tool 读取。` : ""
  }

  let renderedTask = "", renderedCatalog = ""
  globalThis.detectorState = next => {
    if (!next) return
    state = next
    if (pending && state.commandId === pending) pending = null
    busy = active.has(state.task?.status)
    $("connection").textContent = labels[state.connection] || state.connection
    $("backend-note").textContent = `Backend 更新：${new Date(state.updatedAt).toLocaleString()}。若提交后未更新，请打开「插件 → 已安装」触发 host 加载。`
    if (!pending) showError(state.error || state.task?.error)
    const version = JSON.stringify(state.catalog)
    if (version !== renderedCatalog) {
      renderedCatalog = version
      if (actionProvider) { providers.clear(); providers.add(actionProvider); actionProvider = null }
      repaintSelection()
    }
    const taskVersion = JSON.stringify(state.task)
    if (taskVersion !== renderedTask) {
      renderedTask = taskVersion
      const opened = [...document.querySelectorAll(".result")].map((e, i) => e.open ? i : -1)
      renderResults()
      document.querySelectorAll(".result").forEach((e, i) => { e.open = opened.includes(i) })
    }
    counts()
  }

  async function submit(action, input, config) {
    if (pending) return
    if (Date.now() - lastWrite < 1100) { showError("Magpie 每秒允许保存一次 options，请稍后再试。"); return }
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
    pending = id; counts(); showError("")
    try {
      const current = await magpie.options.get()
      options = await magpie.options.set({ ...current, ...config, command: { id, action, ...(input ? { input } : {}), ...(action === "cancel" ? { taskId: state.task.id } : {}) } })
      lastWrite = Date.now()
      $("backend-note").textContent = "已提交，等待 Magpie 加载 plugin backend。"
      // A provider read asks Magpie to refresh its plugin catalog, starting
      // the host after options.set retired it. No model request is made.
      await magpie.read("providers:list")
      loadState()
    } catch (error) { pending = null; showError(error.message); counts() }
  }

  // Only same-folder script assets are permitted by Magpie's page CSP.
  // JSON.stringify in the backend encodes data; this callback never uses HTML.
  let loading = false
  function loadState() {
    if (loading) return
    loading = true
    const script = document.createElement("script")
    script.src = `generated/state.js?t=${Date.now()}`
    const done = () => { loading = false; script.remove() }
    script.onload = done
    script.onerror = done
    document.head.append(script)
  }

  $("save").onclick = () => submit("refresh", null, {
    baseUrl: $("base-url").value.trim(), apiKey: $("api-key").value.trim(), apiKeyEnv: $("key-env").value.trim(),
  })
  $("refresh").onclick = () => submit("refresh")
  $("start").onclick = () => {
    for (const id of ["rounds", "concurrency", "timeout"]) if (!$(id).reportValidity()) return
    submit("start", {
      ...(scope() === "all" ? { all: true } : scope() === "providers" ? { providers: [...providers] } : { models: [...models] }),
      rounds: Number($("rounds").value), concurrency: Number($("concurrency").value), count: Number($("count").value),
      parallel: Number($("parallel").value), strict: $("strict").checked, api: $("api").value,
      timeout: Number($("timeout").value), effort: $("effort").value.trim(), serviceTier: $("service-tier").value,
    })
  }
  $("cancel").onclick = () => submit("cancel")
  $("search").oninput = repaintSelection
  document.querySelectorAll('input[name="scope"]').forEach(radio => { radio.onchange = repaintSelection })
  for (const id of ["rounds", "count"]) $(id).oninput = counts
  $("strict").onchange = () => { if ($("strict").checked) $("count").value = "3"; counts() }
  $("select-visible").onclick = () => {
    const query = $("search").value.trim().toLowerCase(), kind = scope()
    const rows = kind === "providers" ? catalog().providers : catalog().models
    const set = kind === "providers" ? providers : models
    rows.filter(row => `${row.id} ${row.name ?? ""}`.toLowerCase().includes(query)).forEach(row => set.add(row.id))
    repaintSelection()
  }
  $("clear").onclick = () => { models.clear(); providers.clear(); repaintSelection() }
  await magpie.ready
  magpie.onAction(({ provider }) => {
    if (!provider) return
    document.querySelector('input[value="providers"]').checked = true
    actionProvider = provider.id; providers.clear(); providers.add(provider.id); repaintSelection()
  })
  try {
    options = await magpie.options.get()
    $("base-url").value = options.baseUrl || "http://127.0.0.1:3425/v1"
    $("api-key").value = options.apiKey || ""
    $("key-env").value = options.apiKeyEnv || "MAGPIE_DETECTOR_API_KEY"
    $("settings").open = !options.apiKey && !options.apiKeyEnv
  } catch (error) { showError(error.message) }
  try { await magpie.read("providers:list") } catch (error) { showError(error.message) }
  loadState()
  setInterval(loadState, 1500)
})()
