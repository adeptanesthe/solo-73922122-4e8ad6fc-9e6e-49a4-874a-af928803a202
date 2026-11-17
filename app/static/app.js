/* Streaming CTC workbench UI.
 *
 * Every server response carries a monotonically increasing revision.  The UI
 * remembers the revision it currently shows and ignores any response that is
 * older, so a slow advance or undo replay can never overwrite a newer
 * confirm / undo.  Mutating requests are additionally serialised in a small
 * client-side queue, and while a request is in flight the saved subtitle and
 * progress stay on screen until the answer arrives (or an error is shown).
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    connStatus: $("conn-status"),
    setupPanel: $("setup-panel"),
    vocabFile: $("vocab-file"),
    framesFile: $("frames-file"),
    beamWidth: $("beam-width"),
    beamOut: $("beam-out"),
    chunkSize: $("chunk-size"),
    chunkOut: $("chunk-out"),
    loadBtn: $("load-btn"),
    resetBtn: $("reset-btn"),
    setupHint: $("setup-hint"),
    setupError: $("setup-error"),
    sampleButtons: $("sample-buttons"),
    workspace: $("workspace"),
    progressBar: $("progress-bar"),
    progressText: $("progress-text"),
    confirmedText: $("confirmed-text"),
    pendingText: $("pending-text"),
    confirmBest: $("confirm-best"),
    undoBtn: $("undo-btn"),
    stepBtn: $("step-btn"),
    runBtn: $("run-btn"),
    restartBtn: $("restart-btn"),
    stopBtn: $("stop-btn"),
    prefixInput: $("prefix-input"),
    applyPrefix: $("apply-prefix"),
    psText: $("ps-text"),
    psBlank: $("ps-blank"),
    psNonblank: $("ps-nonblank"),
    psTotal: $("ps-total"),
    opError: $("op-error"),
    opNotice: $("op-notice"),
    beamBody: $("beam-body"),
    beamEmpty: $("beam-empty"),
    peekFrame: $("peek-frame"),
    peekFrameOut: $("peek-frame-out"),
    peekNote: $("peek-note"),
    frameProbs: $("frame-probs"),
    historyList: $("history-list"),
    historyEmpty: $("history-empty"),
    busy: $("busy"),
    busyText: $("busy-text"),
    diagPanel: $("diagnosis-panel"),
    diagColumns: $("diag-columns"),
    diagAddSeg: $("diag-add-seg"),
    diagSegments: $("diag-segments"),
    diagRun: $("diag-run"),
    diagSummary: $("diag-summary"),
    diagError: $("diag-error"),
    diagResult: $("diag-result"),
    diagFrameHint: $("diag-frame-hint"),
  };

  const state = {
    sessionId: null,
    generation: 0,      // bumped whenever a new session replaces the old one
    revision: -1,       // revision of the state currently displayed
    snapshot: null,     // last state object accepted from the server
    busy: false,
    running: false,
    runAbort: false,
    pending: 0,
    samples: [],
    // Behind the scenes: the last shown state is kept while a request is in
    // flight, so a failed operation leaves the subtitles and progress intact.
    peekLive: false,
    // Column/character mismatch diagnosis.  A finished diagnosis keeps the
    // frame numbers and subtitles it was computed with; once frames advance or
    // the inputs change, it is marked stale rather than overwritten by a late
    // response.
    diagSeq: 0,
    diagInFlight: false,
    diagResult: null,
    diagStale: false,
    diagStaleReason: "",
  };

  // ---------------------------------------------------------------- helpers

  const fmt = (value) => {
    if (value === null || value === undefined) return "—";
    if (typeof value !== "number" || Number.isNaN(value)) return "—";
    if (!Number.isFinite(value)) return "-∞";
    return value.toFixed(4);
  };

  const pct = (value) => {
    if (!Number.isFinite(value)) return "0";
    if (value >= 0.01) return (value * 100).toFixed(1) + "%";
    return value.toExponential(2);
  };

  function setConnection(kind, label) {
    els.connStatus.dataset.state = kind;
    els.connStatus.textContent = label;
  }

  function setBusy(on, text = "计算中…") {
    state.busy = on;
    els.busy.hidden = !on;
    els.busyText.textContent = text;
    if (on) setConnection("busy", "计算中");
    else updateStatusFromSnapshot();
    updateButtons();
  }

  // Mark an operation as in flight.  Operations are *not* blocked while
  // another one runs: the server applies them in submission order and each
  // response is revision-guarded, so advancing / undoing during a replay is
  // safe and the late replay result cannot overwrite the newer action.
  function beginOp(label) {
    state.pending += 1;
    setBusy(true, label);
  }

  function endOp() {
    state.pending = Math.max(0, state.pending - 1);
    if (state.pending === 0) setBusy(false);
  }

  function updateStatusFromSnapshot() {
    if (!state.snapshot) { setConnection("idle", "未加载"); return; }
    if (state.running) setConnection("busy", "连续推进中");
    else setConnection("ready", "就绪");
  }

  function showError(message) {
    hideNotice();
    if (!message) { els.opError.hidden = true; els.opError.textContent = ""; return; }
    els.opError.hidden = false;
    els.opError.textContent = message;
  }

  function showNotice(message) {
    if (!message) { els.opNotice.hidden = true; els.opNotice.textContent = ""; return; }
    els.opNotice.hidden = false;
    els.opNotice.textContent = message;
  }

  function hideNotice() { els.opNotice.hidden = true; els.opNotice.textContent = ""; }

  function updateButtons() {
    const ready = !!state.sessionId && !!state.snapshot;
    const atEnd = ready && state.snapshot.next_frame >= state.snapshot.frame_count;
    // Recompute (undo replay / long advance) deliberately does NOT disable
    // advance or undo: those actions are queued by the server behind the
    // running operation and applied to its result, in order.
    els.confirmBest.disabled = !ready;
    els.undoBtn.disabled = !ready || (state.snapshot.confirmed_count || 0) === 0;
    els.stepBtn.disabled = !ready || atEnd || state.running;
    els.runBtn.disabled = !ready || atEnd || state.running;
    els.restartBtn.disabled = !ready || state.running;
    els.applyPrefix.disabled = !ready;
    els.stopBtn.hidden = !state.running;
    els.resetBtn.disabled = !ready;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload && payload.detail ? payload.detail : `HTTP ${response.status}`;
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  // Apply a server state snapshot, unless it belongs to a replaced session or
  // is older than the state already displayed.  Together with the server's
  // in-order worker this is what makes late results harmless.
  function applyState(payload, { force = false } = {}) {
    if (!payload || typeof payload.revision !== "number") return false;
    if (payload.session_id !== state.sessionId) return false;
    if (!force && payload.revision < state.revision) return false;
    const advanced = payload.revision > state.revision && state.revision >= 0;
    state.revision = payload.revision;
    state.snapshot = payload;
    // Frames moved (advance / confirm / undo all bump revision): any diagnosis
    // computed at an older boundary must be labelled with its original frames.
    if (advanced && state.diagResult) markDiagnosisStale("推进帧或改动片段后帧边界已变化");
    render();
    return true;
  }

  function startSession(payload, sampleName = null) {
    // Invalidate anything still in flight for the previous session.
    state.generation += 1;
    state.runAbort = true;
    state.running = false;
    state.pending = 0;
    els.stopBtn.hidden = true;
    state.sessionId = payload.session_id;
    state.revision = -1;
    state.snapshot = null;
    state.loadedSample = sampleName;
    state.peekLive = true;
    state.diagSeq += 1;
    state.diagInFlight = false;
    state.diagResult = null;
    state.diagStale = false;
    state.diagStaleReason = "";
    applyState(payload, { force: true });
    if (state.snapshot) {
      els.peekFrame.value = "0";
      els.peekFrame.max = String(state.snapshot.frame_count);
      els.peekFrameOut.textContent = `0 / ${state.snapshot.frame_count}`;
      els.peekNote.textContent = "显示当前帧";
    }
    initDiagnosisPanel();
    updateButtons();
    updateStatusFromSnapshot();
  }

  // ---------------------------------------------------------------- rendering

  function render() {
    const snap = state.snapshot;
    if (!snap) { els.workspace.hidden = true; return; }
    els.workspace.hidden = false;

    const total = snap.frame_count || 0;
    const done = snap.next_frame || 0;
    els.progressBar.style.width = total ? `${(100 * done) / total}%` : "0%";
    els.progressText.textContent = `${done} / ${total} 帧`;

    const best = snap.best_text || "";
    const prefix = snap.prefix || "";
    const pending = best.startsWith(prefix) ? best.slice(prefix.length) : best;
    els.confirmedText.textContent = prefix;
    els.pendingText.textContent = pending;

    const scores = snap.prefix_scores || {};
    els.psText.textContent = scores.text ? `“${scores.text}” → ${scores.last_char}` : "—";
    els.psBlank.textContent = fmt(scores.logp_blank);
    els.psNonblank.textContent = fmt(scores.logp_nonblank);
    els.psBlank.title = "确认时的末字 blank 路径概率（保留值，不随新帧归一化）";
    els.psNonblank.title = "确认时的末字非 blank 路径概率（保留值，不随新帧归一化）";
    els.psTotal.textContent = fmt(scores.logp);
    if (scores.text) {
      els.psTotal.title =
        `确认于第 ${scores.confirmed_at} 帧；此前缀“${scores.text}”的完整前向分数 ` +
        `为 ${fmt(scores.logp)}，其中末字前的前缀分数为 ${fmt(scores.previous_logp)}。` +
        "值保留自确认时刻，不随后续帧或再次确认归一化。";
    } else {
      els.psTotal.title = "尚未确认前缀";
    }

    renderBeams(snap, prefix);

    els.peekFrame.max = String(total);
    if (Number(els.peekFrame.value) > total) els.peekFrame.value = String(total);
    els.peekFrameOut.textContent = `${els.peekFrame.value} / ${total}`;
    els.peekNote.textContent =
      Number(els.peekFrame.value) === done ? "显示当前帧" : "历史回放（只读）";

    renderHistory(snap);
    renderFrameProbs(snap.frame_info);
    els.prefixInput.placeholder = prefix ? `当前前缀：${prefix}` : "例如：啊";
    updateButtons();
    updateStatusFromSnapshot();
  }

  function renderBeams(snap, prefix) {
    const beams = snap.beams || [];
    if (typeof snap.revision === "number") state.peekLive = true;
    els.beamBody.innerHTML = "";
    els.beamEmpty.hidden = beams.length > 0;
    beams.forEach((beam, index) => {
      const tr = document.createElement("tr");
      if (index === 0) tr.className = "selected";

      const idx = document.createElement("td");
      idx.textContent = String(index + 1);

      const textTd = document.createElement("td");
      const span = document.createElement("span");
      span.className = "beam-text";
      const rest = beam.text.startsWith(prefix) ? beam.text.slice(prefix.length) : beam.text;
      if (prefix) {
        const pfx = document.createElement("span");
        pfx.className = "pfx";
        pfx.textContent = prefix;
        span.appendChild(pfx);
      }
      const tail = document.createElement("span");
      if (rest) tail.textContent = rest;
      else { tail.className = "empty-tag"; tail.textContent = "∅"; }
      span.appendChild(tail);
      textTd.appendChild(span);
      if (beam.text.startsWith(prefix)) textTd.title = beam.text;

      const logpTd = document.createElement("td");
      logpTd.className = "num";
      logpTd.textContent = fmt(beam.logp);

      const probTd = document.createElement("td");
      probTd.className = "num";
      probTd.textContent = pct(beam.prob);

      const blankTd = document.createElement("td");
      blankTd.className = "num";
      blankTd.textContent = fmt(beam.logp_blank);

      const nbTd = document.createElement("td");
      nbTd.className = "num";
      nbTd.textContent = fmt(beam.logp_nonblank);

      const actTd = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "确认此候选";
      btn.title = `确认前缀：${beam.text}`;
      btn.disabled = !state.peekLive;
      btn.addEventListener("click", () => confirmPrefix(beam.text));
      actTd.appendChild(btn);

      tr.append(idx, textTd, logpTd, probTd, blankTd, nbTd, actTd);
      els.beamBody.appendChild(tr);
    });
  }

  function renderHistory(snap) {
    const list = snap.confirmations || [];
    els.historyList.innerHTML = "";
    els.historyEmpty.hidden = list.length > 0;
    list.forEach((entry, index) => {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const badge = document.createElement("span");
      badge.className = "h-meta";
      badge.textContent = `#${entry.seq} @${entry.frame} 帧`;
      const prefixSpan = document.createElement("span");
      prefixSpan.className = "h-prefix";
      prefixSpan.textContent = entry.prefix_after || "(空)";
      left.append(badge, document.createTextNode("  "), prefixSpan);

      const right = document.createElement("span");
      right.className = "h-meta";
      right.textContent =
        `logP ${fmt(entry.confirmed_logp)} · blank ${fmt(entry.confirmed_logp_blank)}` +
        ` · 非 blank ${fmt(entry.confirmed_logp_nonblank)}`;

      li.append(left, right);
      if (index === list.length - 1) li.style.borderColor = "rgba(79, 209, 197, .45)";
      els.historyList.appendChild(li);
    });
  }

  function renderFrameProbs(info) {
    els.frameProbs.innerHTML = "";
    if (!info || !info.probs) return;
    const vocab = info.vocab || [];
    info.probs.forEach((value, index) => {
      const cell = document.createElement("div");
      cell.className = "fp" + (value === 0 ? " zero" : "");
      const tok = document.createElement("span");
      tok.className = "tok";
      tok.textContent = index === 0 ? "<blank>" : vocab[index];
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = "  " + value.toFixed(3);
      cell.append(tok, val);
      cell.title = `log P = ${info.log_probs && info.log_probs[index] !== null ? Number(info.log_probs[index]).toFixed(4) : "-∞"}`;
      els.frameProbs.appendChild(cell);
    });
  }

  // ------------------------------------------------------------- operations

  async function withBusy(label, fn) {
    beginOp(label);
    try {
      return await fn();
    } finally {
      endOp();
    }
  }

  async function createSession(formData) {
    els.setupError.hidden = true;
    setBusy(true, "解析并创建会话…");
    try {
      const payload = await api("/api/sessions/upload", { method: "POST", body: formData, headers: {} });
      startSession(payload);
      showError("");
      hideNotice();
      els.loadBtn.disabled = false;
      setConnection("ready", "就绪");
    } catch (error) {
      els.setupError.hidden = false;
      els.setupError.textContent = error.message;
      setConnection("error", "加载失败");
    } finally {
      setBusy(false);
      els.loadBtn.disabled = false;
    }
  }

  async function advanceTo(target, { silentBusy = false } = {}) {
    if (!state.sessionId) return false;
    const sessionId = state.sessionId;
    const generation = state.generation;
    const run = async () => {
      try {
        const payload = await api("/api/advance", {
          method: "POST",
          body: JSON.stringify({
            session_id: sessionId,
            to_frame: target,
          }),
        });
        if (generation !== state.generation || sessionId !== state.sessionId) return false;
        const applied = applyState(payload);
        if (applied) { showError(""); hideNotice(); }
        return applied;
      } catch (error) {
        if (generation !== state.generation || sessionId !== state.sessionId) return false;
        showError(`推进失败：${error.message}（字幕与进度保持不变）`);
        return false;
      }
    };
    return silentBusy ? run() : withBusy("推进帧…", run);
  }

  async function confirmPrefix(prefix) {
    if (!state.sessionId) return;
    if (!prefix || prefix === (state.snapshot && state.snapshot.prefix)) {
      showError("请输入比当前已确认前缀更长的文本");
      return;
    }
    if (!state.peekLive) {
      showError("正在查看历史帧；请先把查看帧拖回当前帧再确认");
      return;
    }
    const sessionId = state.sessionId;
    const generation = state.generation;
    await withBusy("确认前缀…", async () => {
      try {
        const payload = await api("/api/confirm", {
          method: "POST",
          body: JSON.stringify({
            session_id: sessionId,
            prefix,
          }),
        });
        if (generation !== state.generation) return;
        if (applyState(payload)) {
          showError("");
          showNotice(`已确认前缀「${prefix}」。后续只保留兼容候选。`);
          els.prefixInput.value = "";
        }
      } catch (error) {
        showError(`确认失败：${error.message}（前缀与候选保持不变）`);
      }
    });
  }

  async function undo() {
    if (!state.sessionId) return;
    const sessionId = state.sessionId;
    const generation = state.generation;
    await withBusy("撤销确认并重算…", async () => {
      try {
        const payload = await api("/api/undo", {
          method: "POST",
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (generation !== state.generation) return;
        if (applyState(payload)) {
          showError("");
          showNotice("已撤销上次确认，束与分数恢复到未作该次确认时应有的状态。");
          els.prefixInput.value = "";
        }
      } catch (error) {
        showError(`撤销失败：${error.message}（字幕与进度保持不变）`);
      }
    });
  }

  async function peek(frame) {
    if (!state.sessionId) return;
    try {
      const payload = await api("/api/peek", {
        method: "POST",
        body: JSON.stringify({ session_id: state.sessionId, frame }),
      });
      // Peek responses are informational only; they must not clobber the live
      // beam table while newer state is displayed.
      if (payload.revision !== state.revision) return;
      if (!state.snapshot) return;
      if (frame === state.snapshot.next_frame) {
        // Back on the live boundary: show the live state, not a replay.
        state.peekLive = true;
        renderBeams(state.snapshot, state.snapshot.prefix || "");
        renderFrameProbs(state.snapshot.frame_info);
        els.peekNote.textContent = "显示当前帧";
        return;
      }
      const prefix = payload.prefix || "";
      renderBeams({ beams: payload.beams, prefix }, prefix);
      state.peekLive = false;
      renderFrameProbs(payload.frame_info);
      els.peekNote.textContent = `历史回放：第 ${frame} 帧（只读，确认按钮无效）`;
    } catch (error) {
      if (frame === (state.snapshot ? state.snapshot.next_frame : -1)) {
        showError(`查看帧失败：${error.message}`);
      }
    }
  }

  async function runContinuously() {
    if (!state.sessionId || !state.snapshot || state.running) return;
    state.running = true;
    state.runAbort = false;
    state.busy = false;
    updateButtons();
    setConnection("busy", "连续推进中");
    while (state.running && !state.runAbort) {
      const snap = state.snapshot;
      if (!snap || snap.next_frame >= snap.frame_count) break;
      const chunk = Math.max(1, Number(els.chunkSize.value) || 40);
      const target = Math.min(snap.frame_count, snap.next_frame + chunk);
      // Advance without the modal busy overlay; the status pill shows progress.
      const ok = await advanceTo(target, { silentBusy: true });
      if (!ok) break;
      els.peekFrame.value = String(state.snapshot.next_frame);
      els.peekFrameOut.textContent =
        `${state.snapshot.next_frame} / ${state.snapshot.frame_count}`;
      els.peekNote.textContent = "显示当前帧";
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    state.running = false;
    updateButtons();
    updateStatusFromSnapshot();
  }

  // ------------------------------------------------------------- diagnosis

  const DIAG_MAX_SEG = 4;
  const DIAG_MAX_SEG_FRAMES = 64;

  function markDiagnosisStale(reason) {
    if (!state.diagResult || state.diagStale) return;
    state.diagStale = true;
    state.diagStaleReason = reason;
    renderDiagnosis();
  }

  function initDiagnosisPanel() {
    const snap = state.snapshot;
    els.diagColumns.innerHTML = "";
    els.diagSegments.innerHTML = "";
    els.diagError.hidden = true;
    els.diagError.textContent = "";
    els.diagResult.innerHTML = "";
    els.diagSummary.textContent = "";
    if (!snap) return;
    const vocab = snap.vocab || [];
    // Column 0 is blank and never selectable.
    vocab.forEach((token, index) => {
      if (index === 0) return;
      const label = document.createElement("label");
      label.className = "diag-col";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = String(index);
      box.addEventListener("change", () => {
        label.classList.toggle("checked", box.checked);
        markDiagnosisStale("待核对列已修改");
      });
      const char = document.createElement("span");
      char.textContent = token;
      const idx = document.createElement("span");
      idx.className = "col-idx";
      idx.textContent = `#${index} 列`;
      label.append(box, char, idx);
      els.diagColumns.appendChild(label);
    });
    addDiagnosisSegment();
    renderDiagnosis();
  }

  function addDiagnosisSegment() {
    const snap = state.snapshot;
    if (!snap) return;
    if (els.diagSegments.children.length >= DIAG_MAX_SEG) {
      showDiagnosisError(`参考片段最多 ${DIAG_MAX_SEG} 段`);
      return;
    }
    const row = document.createElement("div");
    row.className = "diag-seg";

    const startField = document.createElement("label");
    startField.className = "mini";
    startField.append("起始帧");
    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.min = "0";
    startInput.value = "0";
    startField.appendChild(startInput);

    const endField = document.createElement("label");
    endField.className = "mini";
    endField.append("结束帧（不含）");
    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.min = "1";
    endInput.value = String(Math.min(DIAG_MAX_SEG_FRAMES, snap.next_frame || 1));
    endField.appendChild(endInput);

    const subField = document.createElement("label");
    subField.className = "mini";
    subField.append("参考字幕");
    const subInput = document.createElement("input");
    subInput.type = "text";
    subInput.autocomplete = "off";
    subInput.spellcheck = false;
    subInput.placeholder = "例如：啊";
    subField.appendChild(subInput);

    const meta = document.createElement("div");
    meta.className = "seg-meta";

    const removeField = document.createElement("label");
    removeField.className = "mini";
    removeField.append(" ");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost seg-remove";
    removeBtn.textContent = "删除";
    removeBtn.addEventListener("click", () => {
      if (els.diagSegments.children.length <= 1) {
        showDiagnosisError("至少保留 1 个参考片段");
        return;
      }
      row.remove();
      markDiagnosisStale("参考片段已修改");
    });
    removeField.appendChild(removeBtn);

    [startInput, endInput, subInput].forEach((input) => {
      input.addEventListener("input", () => {
        updateSegmentMeta(row);
        markDiagnosisStale("参考片段已修改");
      });
    });

    row.append(startField, endField, subField, removeField, meta);
    row.dataset.metaAttached = "1";
    els.diagSegments.appendChild(row);
    updateSegmentMeta(row);
  }

  function updateSegmentMeta(row) {
    const inputs = row.querySelectorAll("input");
    const start = Number(inputs[0].value);
    const end = Number(inputs[1].value);
    const meta = row.querySelector(".seg-meta");
    const length = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
    if (Number.isFinite(length) && length > 0) {
      meta.textContent = `${length} 帧${length > DIAG_MAX_SEG_FRAMES ? "（超过 64 帧上限）" : ""}`;
      meta.style.color = length > DIAG_MAX_SEG_FRAMES ? "var(--danger)" : "";
    } else {
      meta.textContent = "结束帧需大于起始帧";
      meta.style.color = "var(--danger)";
    }
  }

  function showDiagnosisError(message) {
    if (!message) { els.diagError.hidden = true; els.diagError.textContent = ""; return; }
    els.diagError.hidden = false;
    els.diagError.textContent = message;
  }

  function readDiagnosisInputs() {
    const columns = [...els.diagColumns.querySelectorAll("input:checked")]
      .map((box) => Number(box.value));
    const segments = [...els.diagSegments.children].map((row) => {
      const inputs = row.querySelectorAll("input");
      return {
        start: Number(inputs[0].value),
        end: Number(inputs[1].value),
        subtitle: inputs[2].value.trim(),
      };
    });
    return { columns, segments };
  }

  function diagnosisSignature(inputs) {
    return JSON.stringify({
      columns: inputs.columns,
      segments: inputs.segments.map((s) => [s.start, s.end, s.subtitle]),
    });
  }

  async function runDiagnosis() {
    if (!state.sessionId || !state.snapshot) return;
    showDiagnosisError("");
    const sessionId = state.sessionId;
    const generation = state.generation;
    const seq = state.diagSeq + 1;
    state.diagSeq = seq;
    const { columns, segments } = readDiagnosisInputs();
    const requestInputs = { columns, segments };
    const requestSignature = diagnosisSignature(requestInputs);
    state.diagInFlight = true;
    els.diagRun.disabled = true;
    els.diagSummary.textContent = "诊断计算中…";

    try {
      const payload = await api("/api/diagnose", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, columns, segments }),
      });
      // A replaced session or a newer diagnosis request makes this late reply
      // harmless: it must never overwrite the result currently on screen.
      if (generation !== state.generation || sessionId !== state.sessionId || seq !== state.diagSeq) {
        return;
      }
      const inputsChanged = diagnosisSignature(readDiagnosisInputs()) !== requestSignature;
      state.diagInFlight = false;
      state.diagResult = { ...payload, inputs: requestInputs };
      state.diagStale = payload.revision !== state.revision || inputsChanged;
      state.diagStaleReason = inputsChanged
        ? "诊断在途时片段或待核对列已修改"
        : "诊断返回前帧边界已变化";
      renderDiagnosis();
    } catch (error) {
      if (generation !== state.generation || sessionId !== state.sessionId || seq !== state.diagSeq) {
        return;
      }
      state.diagInFlight = false;
      els.diagRun.disabled = false;
      els.diagSummary.textContent = "";
      showDiagnosisError(`诊断失败：${error.message}（解码、确认与撤销状态均未改动）`);
    }
  }

  function renderDiagnosis() {
    const snap = state.snapshot;
    if (!snap) return;
    els.diagFrameHint.textContent =
      `已推进到第 ${snap.next_frame} / ${snap.frame_count} 帧边界；诊断只读，不影响解码、确认与撤销。`;
    els.diagRun.disabled = state.diagInFlight || !state.sessionId;
    const result = state.diagResult;
    if (!result) {
      els.diagResult.innerHTML = "";
      if (!state.diagInFlight) els.diagSummary.textContent = "";
      return;
    }

    const vocab = snap.vocab || [];
    els.diagResult.innerHTML = "";

    const verdict = document.createElement("div");
    verdict.className = "diag-verdict";
    const title = document.createElement("div");
    title.className = "v-title";
    const body = document.createElement("div");
    body.className = "v-body";

    if (!result.any_reachable) {
      verdict.classList.add("none");
      title.textContent = "所有候选映射均不可达（存在零概率路径）";
      body.textContent = "每个双射都至少有一段字幕的精确 CTC 路径概率为 0，请检查字幕或帧区间。";
    } else if (result.unique_optimal) {
      verdict.classList.add("unique");
      const winner = result.mappings.find((m) => m.optimal);
      const assignment = winner.assignment
        .map((a) => `${a.char} → 第 ${a.column} 列`)
        .join("，");
      title.textContent = `唯一最优映射：${assignment}`;
      body.textContent =
        `总分（各段对数概率之和）= ${fmt(result.best_logp)}；其余映射分数严格更低。`;
    } else {
      verdict.classList.add("tied");
      title.textContent = `存在 ${result.optimal_count} 个同分最优映射，无法断言唯一`;
      const tied = result.mappings.filter((m) => m.optimal)
        .map((m) => m.assignment.map((a) => `${a.char}→列${a.column}`).join(" "))
        .join("；");
      body.textContent = `最优总分 ${fmt(result.best_logp)}。同分映射：${tied}`;
    }
    verdict.append(title, body);

    if (state.diagStale) {
      const banner = document.createElement("span");
      banner.className = "stale-banner";
      banner.textContent =
        `已过期（${state.diagStaleReason}）。以下结果基于诊断时的帧边界 ` +
        `revision=${result.revision}（当前 revision=${state.revision}），` +
        "原帧号与字幕保留在表中；重新运行诊断以获得新结果。";
      verdict.appendChild(banner);
    }
    els.diagResult.appendChild(verdict);

    // Mapping table.
    const table = document.createElement("table");
    table.className = "diag-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["排名", "映射（单字 → 概率列）", "总分 log P", "各段分数", "结论"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    result.mappings.forEach((mapping, index) => {
      const tr = document.createElement("tr");
      if (mapping.optimal) tr.className = "opt";
      if (!mapping.reachable) tr.classList.add("unreach");

      const rank = document.createElement("td");
      rank.textContent = mapping.optimal
        ? `${index + 1}（最优）`
        : mapping.reachable ? String(index + 1) : "—";

      const assignTd = document.createElement("td");
      assignTd.className = "diag-assign";
      mapping.assignment.forEach((a, i) => {
        if (i > 0) assignTd.appendChild(document.createElement("br"));
        const charSpan = document.createElement("span");
        charSpan.style.color = "var(--accent)";
        charSpan.textContent = a.char;
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = "→";
        const colSpan = document.createElement("span");
        colSpan.textContent = `列 ${a.column}（${vocab[a.column] || ""}）`;
        assignTd.append(charSpan, arrow, colSpan);
      });

      const totalTd = document.createElement("td");
      totalTd.className = "num";
      totalTd.textContent = mapping.reachable ? fmt(mapping.total_logp) : "不可达";

      const segTd = document.createElement("td");
      segTd.className = "diag-seg-scores";
      mapping.segments.forEach((s, i) => {
        if (i > 0) segTd.appendChild(document.createElement("br"));
        const line = document.createElement("span");
        line.textContent =
          `帧 ${s.start}–${s.end - 1}「${s.subtitle}」: ` +
          (s.reachable ? fmt(s.logp) : "");
        if (!s.reachable) {
          const zero = document.createElement("span");
          zero.className = "zero";
          zero.textContent = "零概率，不可达";
          line.appendChild(zero);
        }
        segTd.appendChild(line);
      });

      const badgeTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "diag-badge";
      if (mapping.optimal) {
        badge.classList.add(result.unique_optimal ? "opt" : "tied");
        badge.textContent = result.unique_optimal ? "唯一最优" : "同分最优";
      } else if (!mapping.reachable) {
        badge.classList.add("bad");
        badge.textContent = "不可达";
      } else {
        badge.textContent = "次优";
      }
      badgeTd.appendChild(badge);

      tr.append(rank, assignTd, totalTd, segTd, badgeTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    els.diagResult.appendChild(table);

    const note = document.createElement("p");
    note.className = "hint";
    note.style.marginTop = "10px";
    note.textContent =
      `共枚举 ${result.mappings.length} 个双射；blank（第 0 列）与未选列保持不变。` +
      "分数为该字幕全部 CTC 路径的精确前向概率，未做归一化。";
    els.diagResult.appendChild(note);

    els.diagSummary.textContent = state.diagInFlight
      ? "诊断计算中…"
      : `已列出 ${result.mappings.length} 个映射，其中 ${result.optimal_count} 个最优。`;
    els.diagRun.disabled = state.diagInFlight;
  }

  // ------------------------------------------------------------------- wiring

  els.beamWidth.addEventListener("input", () => {
    els.beamOut.textContent = els.beamWidth.value;
  });
  els.chunkSize.addEventListener("input", () => {
    els.chunkOut.textContent = els.chunkSize.value;
  });

  els.loadBtn.addEventListener("click", () => {
    const vocabFile = els.vocabFile.files[0];
    const framesFile = els.framesFile.files[0];
    if (!vocabFile || !framesFile) {
      els.setupError.hidden = false;
      els.setupError.textContent = "请同时选择词表文件和逐帧概率文件";
      return;
    }
    const form = new FormData();
    form.append("vocab_file", vocabFile);
    form.append("frames_file", framesFile);
    form.append("beam_width", els.beamWidth.value);
    createSession(form);
  });

  els.resetBtn.addEventListener("click", async () => {
    if (state.sessionId) {
      try {
        await api(`/api/sessions/${state.sessionId}`, { method: "DELETE" });
      } catch { /* ignore */ }
    }
    state.sessionId = null;
    state.revision = -1;
    state.snapshot = null;
    els.workspace.hidden = true;
    state.loadedSample = null;
    setConnection("idle", "未加载");
    updateButtons();
  });

  els.confirmBest.addEventListener("click", () => {
    const snap = state.snapshot;
    if (!snap) return;
    const best = snap.best_text || "";
    let target = best;
    if (!best || best === snap.prefix) {
      showError("当前最佳候选与已确认前缀相同，无法继续确认");
      return;
    }
    // confirm the full best hypothesis; users can also type a shorter prefix
    confirmPrefix(target);
  });

  els.applyPrefix.addEventListener("click", () => {
    confirmPrefix(els.prefixInput.value.trim());
  });

  els.prefixInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPrefix(els.prefixInput.value.trim());
    }
  });

  els.undoBtn.addEventListener("click", undo);

  els.stepBtn.addEventListener("click", async () => {
    const snap = state.snapshot;
    if (!snap) return;
    const chunk = Math.max(1, Number(els.chunkSize.value) || 40);
    const target = Math.min(snap.frame_count, snap.next_frame + chunk);
    const ok = await advanceTo(target);
    if (ok) {
      els.peekFrame.value = String(state.snapshot.next_frame);
      els.peekFrameOut.textContent = `${els.peekFrame.value} / ${state.snapshot.frame_count}`;
      els.peekNote.textContent = "显示当前帧";
      renderFrameProbs(state.snapshot.frame_info);
    }
  });

  els.runBtn.addEventListener("click", runContinuously);
  els.stopBtn.addEventListener("click", () => {
    state.runAbort = true;
    state.running = false;
    updateButtons();
    updateStatusFromSnapshot();
  });

  els.restartBtn.addEventListener("click", async () => {
    // Reset by opening a fresh server session from the same sample or files.
    state.runAbort = true;
    if (state.loadedSample) {
      await loadSample(state.loadedSample);
      return;
    }
    if (!els.vocabFile.files[0] || !els.framesFile.files[0]) {
      showError("要回到起点请重新选择文件或重新载入样例");
      return;
    }
    const form = new FormData();
    form.append("vocab_file", els.vocabFile.files[0]);
    form.append("frames_file", els.framesFile.files[0]);
    form.append("beam_width", els.beamWidth.value);
    await createSession(form);
  });

  els.peekFrame.addEventListener("input", () => {
    const frame = Number(els.peekFrame.value);
    els.peekFrameOut.textContent = `${frame} / ${els.peekFrame.max}`;
    peek(frame);
  });

  els.diagAddSeg.addEventListener("click", addDiagnosisSegment);
  els.diagRun.addEventListener("click", runDiagnosis);

  async function loadSamples() {
    try {
      const payload = await api("/api/samples");
      state.samples = payload.samples || [];
      els.sampleButtons.innerHTML = "";
      if (!state.samples.length) {
        const span = document.createElement("span");
        span.className = "hint";
        span.textContent = "未找到样例文件";
        els.sampleButtons.appendChild(span);
        return;
      }
      state.samples.forEach((sample) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sample ghost";
        btn.textContent = sample.name;
        btn.addEventListener("click", () => loadSample(sample.name));
        els.sampleButtons.appendChild(btn);
      });
    } catch { /* samples are optional */ }
  }

  async function loadSample(name) {
    els.setupError.hidden = true;
    setBusy(true, "载入样例…");
    try {
      const sample = await api(`/api/samples/${encodeURIComponent(name)}`);
      const payload = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          vocab: sample.vocab,
          beam_width: Number(els.beamWidth.value),
          frames: sample.frames,
        }),
      });
      startSession(payload, name);
      showError("");
      hideNotice();
      showNotice(`已载入样例「${name}」，共 ${payload.frame_count} 帧。`);
    } catch (error) {
      els.setupError.hidden = false;
      els.setupError.textContent = error.message;
      setConnection("error", "加载失败");
    } finally {
      setBusy(false);
    }
  }

  loadSamples();
  updateButtons();
  updateStatusFromSnapshot();
})();
