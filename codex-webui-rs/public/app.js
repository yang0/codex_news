const statusBadge = document.querySelector("#statusBadge");
const threadValue = document.querySelector("#threadValue");
const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const sendButton = document.querySelector("#sendButton");
const stopButton = document.querySelector("#stopButton");
const reconnectButton = document.querySelector("#reconnectButton");
const clearButton = document.querySelector("#clearButton");
const resetThreadButton = document.querySelector("#resetThreadButton");
const runStatusLine = document.querySelector("#runStatusLine");
const runStatusSpinner = document.querySelector("#runStatusSpinner");
const runStatusText = document.querySelector("#runStatusText");
const runStatusMeta = document.querySelector("#runStatusMeta");

const state = {
  backend: "unknown",
  busy: false,
  connected: false,
  currentRunId: null,
  itemBubbles: new Map(),
  toolItems: new Map(),
  streamTargets: new Map(),
  itemDeltaQueue: new Map(),
  itemDeltaTimer: null,
  fullReasoningBuffer: "",
  reasoningBuffer: "",
  runStartedAt: null,
  runStatusHeader: "Working",
  runStatusInlineMessage: null,
  runStatusTimer: null,
  socket: null,
  threadId: null,
};

const DEBUG_LOG = new URLSearchParams(window.location.search).get("debug") !== "0";
const CLI_LIKE_MODE = true;
const QUIET_EVENT_TYPES = new Set([
  "account/rateLimits/updated",
  "codex/event/agent_message",
  "codex/event/agent_reasoning",
  "codex/event/agent_reasoning_section_break",
  "codex/event/task_complete",
  "codex/event/task_started",
  "codex/event/token_count",
  "codex/event/user_message",
  "thread/status/changed",
  "thread/tokenUsage/updated",
]);
const STATUS_DOT_FRAMES = ["•", "◦"];

function debugLog(...args) {
  if (!DEBUG_LOG) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[codex-webui]", ...args);
}

connect();
wireEvents();
syncControls();

function wireEvents() {
  composer.addEventListener("submit", (event) => {
    event.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt || !state.connected || state.busy) {
      return;
    }

    addChatMessage("user", prompt);
    debugLog("submit prompt", { length: prompt.length, preview: prompt.slice(0, 80) });
    sendPayload({ type: "prompt", prompt });

    state.busy = true;
    state.currentRunId = null;
    state.itemBubbles.clear();
    promptInput.value = "";

    addInfoEvent("Prompt sent. Waiting for Codex...");
    syncControls();
  });

  promptInput.addEventListener("input", () => {
    syncControls();
  });

  stopButton.addEventListener("click", () => {
    if (!state.connected || !state.busy) {
      return;
    }

    debugLog("submit cancel");
    sendPayload({ type: "cancel" });
  });

  reconnectButton.addEventListener("click", () => {
    debugLog("reconnect click");
    connect(true);
  });

  clearButton.addEventListener("click", () => {
    messages.innerHTML = "";
    state.itemBubbles.clear();
    state.toolItems.clear();
    state.streamTargets.clear();
    clearDeltaQueue();
  });

  resetThreadButton.addEventListener("click", () => {
    if (!state.connected || state.busy) {
      return;
    }

    debugLog("submit reset_thread");
    sendPayload({ type: "reset_thread" });
  });
}

function connect(forceReconnect = false) {
  if (state.socket && !forceReconnect) {
    const readyState = state.socket.readyState;
    if (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN) {
      return;
    }
  }

  if (forceReconnect && state.socket) {
    state.socket.close();
  }

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${window.location.host}/ws`;
  debugLog("connect", { wsUrl, forceReconnect });

  setStatus("connecting", "Connecting...");

  const socket = new WebSocket(wsUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    debugLog("ws open");
    state.connected = true;
    setStatus("connected", "Connected");
    syncControls();
  });

  socket.addEventListener("message", (event) => {
    debugLog("ws message", truncateText(event.data, 200));
    handleServerMessage(event.data);
  });

  socket.addEventListener("close", () => {
    debugLog("ws close");
    state.connected = false;
    state.busy = false;
    state.currentRunId = null;
    state.itemBubbles.clear();
    state.toolItems.clear();
    state.streamTargets.clear();
    clearDeltaQueue();
    stopRunStatusLine();
    setStatus("disconnected", "Disconnected");
    addEvent("Connection closed. Click Reconnect to continue.", "warn");
    syncControls();
  });

  socket.addEventListener("error", () => {
    debugLog("ws error");
    state.connected = false;
    setStatus("error", "Connection error");
    syncControls();
  });
}

function handleServerMessage(raw) {
  let message;

  try {
    message = JSON.parse(raw);
  } catch {
    addEvent(`Invalid server message: ${raw}`, "error");
    return;
  }

  debugLog("server event", { type: String(message.type) });

  switch (message.type) {
    case "connected": {
      state.backend = typeof message.backend === "string" ? message.backend : "unknown";
      state.threadId = message.threadId ?? null;
      updateThreadText();
      addInfoEvent(`Session ready (${truncateId(message.sessionId)}) via ${state.backend}`);
      return;
    }
    case "backend_ready": {
      const ua = typeof message.userAgent === "string" ? `, userAgent=${message.userAgent}` : "";
      addInfoEvent(`Backend initialized: ${message.backend ?? "unknown"}${ua}`);
      return;
    }
    case "run_started": {
      state.busy = true;
      state.currentRunId = message.runId;
      state.itemBubbles.clear();
      state.toolItems.clear();
      state.streamTargets.clear();
      clearDeltaQueue();
      state.runStatusHeader = "Working";
      state.runStatusInlineMessage = null;
      state.reasoningBuffer = "";
      state.fullReasoningBuffer = "";
      startRunStatusLine();

      if (message.resumedThreadId) {
        addInfoEvent(`Run started and resumed thread ${truncateId(message.resumedThreadId)}`);
      } else {
        addInfoEvent("Run started with a fresh thread");
      }

      syncControls();
      return;
    }
    case "codex_event": {
      if (!state.currentRunId) {
        state.currentRunId = message.runId;
      }

      if (typeof message.threadId === "string") {
        state.threadId = message.threadId;
        updateThreadText();
      }

      handleCodexEvent(message.event);
      return;
    }
    case "codex_raw": {
      addEvent(message.text, "raw");
      return;
    }
    case "codex_stderr": {
      addEvent(message.text, "error");
      return;
    }
    case "cancel_requested": {
      setRunStatusHeader("Interrupting");
      addEvent("Cancellation requested...");
      return;
    }
    case "run_finished": {
      state.busy = false;
      state.currentRunId = null;
      flushDeltaQueueAll();
      stopDeltaQueueTimer();
      state.itemBubbles.clear();
      state.toolItems.clear();
      state.streamTargets.clear();
      state.runStatusInlineMessage = null;
      state.reasoningBuffer = "";
      state.fullReasoningBuffer = "";
      stopRunStatusLine();
      const turnStatus =
        typeof message.turnStatus === "string" ? `status: ${message.turnStatus}` : null;
      const exitCode =
        typeof message.exitCode !== "undefined" ? `exit code: ${String(message.exitCode)}` : null;
      const label = turnStatus ?? exitCode ?? "completed";
      addInfoEvent(`Run finished (${label})`, true);
      syncControls();
      return;
    }
    case "run_cancelled": {
      state.busy = false;
      state.currentRunId = null;
      flushDeltaQueueAll();
      stopDeltaQueueTimer();
      state.itemBubbles.clear();
      state.toolItems.clear();
      state.streamTargets.clear();
      state.runStatusInlineMessage = null;
      state.reasoningBuffer = "";
      state.fullReasoningBuffer = "";
      stopRunStatusLine();
      const reason = typeof message.reason === "string" ? ` (${message.reason})` : "";
      addEvent(`Run cancelled${reason}`, "warn");
      syncControls();
      return;
    }
    case "thread_reset": {
      state.threadId = typeof message.threadId === "string" ? message.threadId : null;
      updateThreadText();
      addInfoEvent(message.message ?? "Thread reset", true);
      syncControls();
      return;
    }
    case "error": {
      addEvent(message.message ?? "Unknown server error", "error");
      syncControls();
      return;
    }
    default: {
      addEvent(`Unhandled message type: ${String(message.type)}`, "warn");
    }
  }
}

function handleCodexEvent(event) {
  if (!event || typeof event !== "object") {
    addEvent("Received malformed Codex event", "warn");
    return;
  }

  if (CLI_LIKE_MODE && !isCliRelevantEvent(event.type)) {
    return;
  }

  if (isQuietEventType(event.type)) {
    return;
  }

  switch (event.type) {
    case "thread.started": {
      if (typeof event.thread_id === "string") {
        state.threadId = event.thread_id;
        updateThreadText();
      }
      addInfoEvent(`Thread: ${truncateId(state.threadId)}`);
      return;
    }
    case "turn.started": {
      setRunStatusHeader("Working");
      addInfoEvent("Codex is thinking...");
      return;
    }
    case "item.started": {
      updateStatusHeaderFromItem(event.item);
      renderStartedItem(event.item);
      return;
    }
    case "item/reasoning/summaryPartAdded": {
      onReasoningSectionBreak();
      return;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        onReasoningDelta(delta);
      }
      return;
    }
    case "item.completed": {
      updateStatusHeaderFromItem(event.item);
      renderCompletedItem(event.item);
      return;
    }
    case "item.delta": {
      renderDeltaItem(event);
      return;
    }
    case "turn.completed": {
      renderTurnCompleted(event.usage);
      return;
    }
    case "item.command_output_delta":
    case "item.file_change_output_delta": {
      renderToolOutputDelta(event);
      return;
    }
    default: {
      const summary = summarizeEvent(event);
      if (summary) {
        addInfoEvent(summary);
      }
    }
  }
}

function renderCompletedItem(item) {
  if (!item || typeof item !== "object") {
    return;
  }

  const itemType = typeof item.type === "string" ? item.type : "unknown";

  if (itemType === "agent_message") {
    const bubble = ensureItemBubble(item.id, "assistant");
    flushDeltaQueueForKey(itemBubbleKey(item.id));
    const text = extractItemText(item);
    bubble.textContent = text || "(empty message)";
    scrollMessagesToBottom();
    return;
  }

  if (itemType === "reasoning") {
    onReasoningFinal();
    if (!CLI_LIKE_MODE) {
      const text = extractItemText(item);
      if (text) {
        addInfoEvent(`Reasoning: ${text}`, true);
      }
    }
    return;
  }

  if (itemType === "user_message") {
    return;
  }

  if (itemType === "command_execution" || itemType === "file_change") {
    renderToolItem(item, true);
  }
}

function renderStartedItem(item) {
  if (!item || typeof item !== "object") {
    return;
  }

  const itemType = typeof item.type === "string" ? item.type : "";
  if (itemType === "command_execution" || itemType === "file_change") {
    renderToolItem(item, false);
  }
}

function renderToolItem(item, completed) {
  const itemType = typeof item.type === "string" ? item.type : "";
  if (itemType !== "command_execution" && itemType !== "file_change") {
    return;
  }

  const itemId = typeof item.id === "string" ? item.id : null;
  const record = ensureToolItemRecord(itemId, itemType);
  record.itemType = itemType;

  if (itemType === "command_execution") {
    renderCommandToolItem(record, item, completed);
    return;
  }

  renderFileChangeToolItem(record, item, completed);
}

function renderCommandToolItem(record, item, completed) {
  const status = normalizeItemStatus(item.status, completed);
  const tone = toneForStatus(status);
  const command = commandTextFromItem(item);
  const headerVerb = status === "inProgress" ? "Running" : "Ran";

  setSegmentLine(record.header, [
    seg("•", `cli-bullet ${colorClassForTone(tone)}`),
    seg(" "),
    seg(headerVerb, "cli-strong"),
    seg(" "),
    seg("$ ", "cli-command"),
    seg(command, "cli-command"),
    ...(status === "declined" ? [seg(" (declined)", "cli-error")] : []),
  ]);

  const details = [];
  if (status === "inProgress") {
    const cwd = cwdTextFromItem(item);
    if (cwd) {
      details.push([seg("  └ ", "cli-meta"), seg(cwd, "cli-meta")]);
    }
  } else {
    const line = [];
    if (status === "completed") {
      line.push(seg("✓", "cli-success cli-strong"));
    } else {
      line.push(seg("✗", "cli-error cli-strong"));
    }

    if (status === "failed") {
      const exitCode = exitCodeFromItem(item);
      if (typeof exitCode === "number") {
        line.push(seg(` (${exitCode})`, "cli-error"));
      } else {
        line.push(seg(" failed", "cli-error"));
      }
    } else if (status === "declined") {
      line.push(seg(" declined", "cli-error"));
    }

    const duration = durationFromItem(item);
    if (duration) {
      line.push(seg(` • ${duration}`, "cli-meta"));
    }
    details.push(line);
  }

  setSegmentLines(record.details, details);
  record.container.dataset.tone = tone;
  hydrateToolOutputFromCompletedItem(record, item);
}

function renderFileChangeToolItem(record, item, completed) {
  const status = normalizeItemStatus(item.status, completed);
  const tone = toneForStatus(status);
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const count = changes.length;
  const title =
    status === "inProgress"
      ? "Applying patch"
      : status === "completed"
        ? "Applied patch"
        : status === "declined"
          ? "Declined patch"
          : "Failed patch";

  const header = [seg("•", `cli-bullet ${colorClassForTone(tone)}`), seg(" "), seg(title, "cli-strong")];
  if (count > 0) {
    header.push(seg(` (${count} ${count === 1 ? "file" : "files"})`, "cli-meta"));
  }
  setSegmentLine(record.header, header);

  const details = buildFileChangeDetails(changes);
  setSegmentLines(record.details, details);
  record.container.dataset.tone = tone;
  hydrateToolOutputFromCompletedItem(record, item);
}

function renderToolOutputDelta(event) {
  if (!event || typeof event !== "object") {
    return;
  }

  const text = typeof event.text === "string" ? event.text : "";
  if (!text) {
    return;
  }

  const itemId = typeof event.item_id === "string" ? event.item_id : null;
  const itemType = event.type === "item.command_output_delta" ? "command_execution" : "file_change";
  const record = ensureToolItemRecord(itemId, itemType);
  record.itemType = itemType;
  appendToolOutput(record, text);
}

function renderDeltaItem(event) {
  const item = event.item;
  if (!item || typeof item !== "object") {
    return;
  }

  if (item.type !== "agent_message") {
    return;
  }

  const deltaText = extractDeltaText(event);
  if (!deltaText) {
    return;
  }

  const key = itemBubbleKey(item.id);
  ensureItemBubble(item.id, "assistant");
  queueAssistantDelta(key, deltaText);
}

function renderTurnCompleted(usage) {
  setRunStatusHeader("Working");
  if (!usage || typeof usage !== "object") {
    addInfoEvent("Turn completed");
    return;
  }

  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? "?";
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? "?";
  addInfoEvent(`Turn completed. tokens in/out: ${inputTokens}/${outputTokens}`);
}

function ensureItemBubble(itemId, role) {
  const key = itemBubbleKey(itemId);
  const existing = state.itemBubbles.get(key);
  if (existing) {
    return existing;
  }

  const message = document.createElement("article");
  message.className = `chat-message ${role}`;

  const meta = document.createElement("div");
  meta.className = "chat-meta";
  meta.textContent = role === "assistant" ? "Codex" : "System";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  message.append(meta, bubble);
  messages.append(message);

  state.itemBubbles.set(key, bubble);
  state.streamTargets.set(key, bubble);

  scrollMessagesToBottom();
  return bubble;
}

function itemBubbleKey(itemId) {
  return itemId ? `${state.currentRunId ?? "run"}:${itemId}` : `${state.currentRunId ?? "run"}:fallback`;
}

function addChatMessage(role, text) {
  const message = document.createElement("article");
  message.className = `chat-message ${role}`;

  const meta = document.createElement("div");
  meta.className = "chat-meta";
  meta.textContent = role === "user" ? "You" : "Codex";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;

  message.append(meta, bubble);
  messages.append(message);

  scrollMessagesToBottom();
}

function addEvent(text, level = "info") {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  const line = document.createElement("div");
  line.className = `event-line ${level}`;

  if (level === "raw") {
    line.classList.add("cli-raw-line");
    line.textContent = safeText;
  } else if (level === "warn") {
    appendSegments(line, [seg("⚠ ", "cli-warning cli-strong"), seg(safeText, "cli-warning")]);
  } else if (level === "error") {
    appendSegments(line, [seg("✘ ", "cli-error cli-strong"), seg(safeText, "cli-error")]);
  } else {
    appendSegments(line, [seg("• ", "cli-meta"), seg(safeText, "cli-meta")]);
  }

  messages.append(line);
  scrollMessagesToBottom();
}

function sendPayload(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    debugLog("send blocked: socket not open", { payload });
    addEvent("WebSocket is not connected", "error");
    return;
  }

  debugLog("send payload", payload);
  state.socket.send(JSON.stringify(payload));
}

function syncControls() {
  const prompt = promptInput.value.trim();
  sendButton.disabled = !state.connected || state.busy || !prompt;
  stopButton.disabled = !state.connected || !state.busy;
  resetThreadButton.disabled = !state.connected || state.busy;

  if (state.connected && state.busy) {
    setStatus("busy", "Running");
  } else if (state.connected) {
    setStatus("connected", "Connected");
  }
}

function setStatus(kind, text) {
  statusBadge.textContent = text;
  statusBadge.dataset.kind = kind;
}

function updateThreadText() {
  threadValue.textContent = state.threadId ? truncateId(state.threadId) : "none";
  threadValue.title = state.threadId ?? "";
}

function scrollMessagesToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function truncateText(text, maxChars) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(len=${value.length})`;
}

function truncateId(value) {
  if (!value) {
    return "none";
  }

  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function summarizeItem(item) {
  const itemType = typeof item.type === "string" ? item.type : "unknown";
  if (itemType === "command_execution") {
    const status = typeof item.status === "string" ? item.status : "unknown";
    const command = typeof item.command === "string" ? item.command : "(unknown command)";
    return `${itemType} ${status}: ${command}`;
  }

  if (itemType === "file_change") {
    const status = typeof item.status === "string" ? item.status : "unknown";
    return `${itemType} ${status}`;
  }

  if (CLI_LIKE_MODE) {
    return null;
  }

  const text = extractItemText(item);
  if (text) {
    return `${itemType}: ${text}`;
  }
  return `${itemType} completed`;
}

function summarizeEvent(event) {
  if (typeof event.type !== "string") {
    return "unknown event";
  }

  if (event.type === "item.started" && event.item && typeof event.item.type === "string") {
    if (event.item.type === "command_execution" || event.item.type === "file_change") {
      return `${event.item.type} started`;
    }
    return null;
  }

  if (event.type.includes("/")) {
    if (CLI_LIKE_MODE) {
      return null;
    }
    return event.type;
  }

  return null;
}

function addInfoEvent(text, force = false) {
  if (CLI_LIKE_MODE && !force) {
    return;
  }
  addEvent(text, "info");
}

function isQuietEventType(type) {
  if (typeof type !== "string") {
    return false;
  }
  return QUIET_EVENT_TYPES.has(type);
}

function isCliRelevantEvent(type) {
  if (typeof type !== "string") {
    return false;
  }

  switch (type) {
    case "thread.started":
    case "turn.started":
    case "turn.completed":
    case "item.started":
    case "item.completed":
    case "item.delta":
    case "item.command_output_delta":
    case "item.file_change_output_delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return true;
    default:
      return false;
  }
}

function updateStatusHeaderFromItem(item) {
  if (!item || typeof item !== "object") {
    return;
  }

  const itemType = typeof item.type === "string" ? item.type : "";
  if (itemType === "command_execution") {
    setRunStatusHeader("Running command");
    if (typeof item.command === "string" && item.command.trim()) {
      setRunStatusInlineMessage(truncateInline(`$ ${item.command.trim()}`, 72));
    } else {
      setRunStatusInlineMessage(null);
    }
    return;
  }

  if (itemType === "file_change") {
    setRunStatusHeader("Applying patch");
    if (Array.isArray(item.changes) && item.changes.length > 0) {
      setRunStatusInlineMessage(
        item.changes.length === 1 ? "Editing 1 file" : `Editing ${item.changes.length} files`,
      );
    } else {
      setRunStatusInlineMessage(null);
    }
    return;
  }

  if (itemType === "agent_message") {
    setRunStatusHeader("Working");
    setRunStatusInlineMessage(null);
    return;
  }

  if (itemType === "reasoning") {
    setRunStatusInlineMessage(null);
  }
}

function startRunStatusLine() {
  state.runStartedAt = Date.now();
  runStatusLine.hidden = false;
  runStatusLine.dataset.animated = "true";
  updateRunStatusLine();

  if (state.runStatusTimer) {
    window.clearInterval(state.runStatusTimer);
  }

  state.runStatusTimer = window.setInterval(() => {
    updateRunStatusLine();
  }, 200);
}

function stopRunStatusLine() {
  if (state.runStatusTimer) {
    window.clearInterval(state.runStatusTimer);
    state.runStatusTimer = null;
  }

  state.runStartedAt = null;
  runStatusLine.hidden = true;
  runStatusLine.dataset.animated = "false";
  runStatusSpinner.textContent = "•";
  runStatusText.textContent = "Working";
  runStatusLine.dataset.tone = "working";
  runStatusMeta.textContent = "(0s • Stop to interrupt)";
}

function setRunStatusHeader(header) {
  if (typeof header !== "string" || !header.trim()) {
    return;
  }

  state.runStatusHeader = header.trim();
  if (state.busy) {
    updateRunStatusLine();
  }
}

function setRunStatusInlineMessage(message) {
  state.runStatusInlineMessage =
    typeof message === "string" && message.trim() ? message.trim() : null;
  if (state.busy) {
    updateRunStatusLine();
  }
}

function queueAssistantDelta(key, deltaText) {
  queueStreamDelta(key, deltaText);
}

function queueStreamDelta(key, deltaText) {
  const previous = state.itemDeltaQueue.get(key) ?? "";
  state.itemDeltaQueue.set(key, `${previous}${deltaText}`);
  startDeltaQueueTimer();
}

function startDeltaQueueTimer() {
  if (state.itemDeltaTimer) {
    return;
  }

  state.itemDeltaTimer = window.setInterval(() => {
    flushDeltaQueueStep();
  }, 35);
}

function stopDeltaQueueTimer() {
  if (!state.itemDeltaTimer) {
    return;
  }
  window.clearInterval(state.itemDeltaTimer);
  state.itemDeltaTimer = null;
}

function clearDeltaQueue() {
  state.itemDeltaQueue.clear();
  stopDeltaQueueTimer();
}

function flushDeltaQueueAll() {
  for (const key of state.itemDeltaQueue.keys()) {
    flushDeltaQueueForKey(key);
  }
  state.itemDeltaQueue.clear();
}

function flushDeltaQueueStep() {
  if (state.itemDeltaQueue.size === 0) {
    stopDeltaQueueTimer();
    return;
  }

  let updated = false;
  for (const [key, pending] of state.itemDeltaQueue) {
    if (!pending) {
      state.itemDeltaQueue.delete(key);
      continue;
    }

    const target = state.streamTargets.get(key);
    if (!target) {
      state.itemDeltaQueue.delete(key);
      continue;
    }

    const chunk = takeDeltaChunk(pending, key);
    target.textContent += chunk;
    const rest = pending.slice(chunk.length);
    if (rest) {
      state.itemDeltaQueue.set(key, rest);
    } else {
      state.itemDeltaQueue.delete(key);
    }
    updated = true;
  }

  if (updated) {
    scrollMessagesToBottom();
  }

  if (state.itemDeltaQueue.size === 0) {
    stopDeltaQueueTimer();
  }
}

function flushDeltaQueueForKey(key) {
  const pending = state.itemDeltaQueue.get(key);
  if (!pending) {
    return;
  }
  const target = state.streamTargets.get(key);
  if (target) {
    target.textContent += pending;
  }
  state.itemDeltaQueue.delete(key);
}

function takeDeltaChunk(text, key) {
  const chunkSize = key.startsWith("tool-output:") ? 36 : 12;

  if (typeof text !== "string" || text.length <= chunkSize) {
    return text;
  }

  const newlineIndex = text.indexOf("\n");
  if (newlineIndex >= 0 && newlineIndex < chunkSize * 2) {
    return text.slice(0, newlineIndex + 1);
  }

  return text.slice(0, chunkSize);
}

function updateRunStatusLine() {
  if (!state.busy || !state.runStartedAt) {
    return;
  }

  const elapsedMs = Date.now() - state.runStartedAt;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const frameIndex = Math.floor(elapsedMs / 600) % STATUS_DOT_FRAMES.length;

  runStatusSpinner.textContent = STATUS_DOT_FRAMES[frameIndex];
  runStatusText.textContent = state.runStatusHeader;
  runStatusLine.dataset.tone = statusToneForHeader(state.runStatusHeader);
  const inline = state.runStatusInlineMessage ? ` · ${state.runStatusInlineMessage}` : "";
  runStatusMeta.textContent = `(${formatElapsedCompact(elapsedSeconds)} • Stop to interrupt)${inline}`;
}

function onReasoningDelta(delta) {
  state.reasoningBuffer += delta;
  const header = extractFirstBold(state.reasoningBuffer);
  if (header) {
    setRunStatusHeader(header);
  }
}

function onReasoningSectionBreak() {
  state.fullReasoningBuffer += state.reasoningBuffer;
  state.fullReasoningBuffer += "\n\n";
  state.reasoningBuffer = "";
}

function onReasoningFinal() {
  state.fullReasoningBuffer += state.reasoningBuffer;
  state.reasoningBuffer = "";
  if (state.runStatusHeader !== "Running command" && state.runStatusHeader !== "Applying patch") {
    setRunStatusHeader("Working");
  }
}

function extractFirstBold(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  const match = text.match(/\*\*([^*][\s\S]*?)\*\*/);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim() || null;
}

function truncateInline(value, maxChars) {
  if (typeof value !== "string" || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function extractItemText(item) {
  if (typeof item.text === "string") {
    return item.text;
  }

  if (typeof item.message === "string") {
    return item.message;
  }

  if (typeof item.aggregated_output === "string") {
    return item.aggregated_output;
  }

  if (typeof item.aggregatedOutput === "string") {
    return item.aggregatedOutput;
  }

  if (Array.isArray(item.summary)) {
    return item.summary
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  if (!Array.isArray(item.content)) {
    return "";
  }

  const parts = [];
  for (const entry of item.content) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }

    if (entry && typeof entry === "object") {
      if (typeof entry.text === "string") {
        parts.push(entry.text);
        continue;
      }

      if (typeof entry.output_text === "string") {
        parts.push(entry.output_text);
      }
    }
  }

  return parts.join("");
}

function extractDeltaText(event) {
  if (typeof event.delta === "string") {
    return event.delta;
  }

  if (event.delta && typeof event.delta === "object" && typeof event.delta.text === "string") {
    return event.delta.text;
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  return "";
}

function ensureToolItemRecord(itemId, itemType) {
  const key = toolItemKey(itemId, itemType);
  const existing = state.toolItems.get(key);
  if (existing) {
    return existing;
  }

  const container = document.createElement("div");
  container.className = "event-line info cli-tool-item";
  container.dataset.tone = "running";

  const header = document.createElement("div");
  header.className = "cli-tool-header";

  const details = document.createElement("div");
  details.className = "cli-tool-details";
  details.hidden = true;

  const output = document.createElement("pre");
  output.className = "cli-tool-output cli-meta";
  output.hidden = true;

  container.append(header, details, output);
  messages.append(container);

  const outputKey = `tool-output:${key}`;
  state.streamTargets.set(outputKey, output);

  const record = {
    key,
    itemId,
    itemType,
    container,
    header,
    details,
    output,
    outputAtLineStart: true,
    outputStarted: false,
    outputKey,
    sawOutput: false,
  };
  state.toolItems.set(key, record);

  scrollMessagesToBottom();
  return record;
}

function toolItemKey(itemId, fallbackType = "tool") {
  const runPart = state.currentRunId ?? "run";
  if (typeof itemId === "string" && itemId.trim()) {
    return `${runPart}:${itemId}`;
  }
  return `${runPart}:${fallbackType}:fallback`;
}

function appendToolOutput(record, text) {
  const prefixed = prefixToolOutput(record, text);
  if (!prefixed) {
    return;
  }
  record.sawOutput = true;
  record.output.hidden = false;
  queueStreamDelta(record.outputKey, prefixed);
}

function prefixToolOutput(record, text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  let out = "";
  for (const ch of text) {
    if (record.outputAtLineStart) {
      out += record.outputStarted ? "    " : "  └ ";
      record.outputStarted = true;
      record.outputAtLineStart = false;
    }
    out += ch;
    if (ch === "\n") {
      record.outputAtLineStart = true;
    }
  }
  return out;
}

function hydrateToolOutputFromCompletedItem(record, item) {
  if (record.sawOutput) {
    return;
  }
  const output = outputTextFromItem(item);
  if (!output) {
    return;
  }
  appendToolOutput(record, output.endsWith("\n") ? output : `${output}\n`);
}

function outputTextFromItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (typeof item.aggregated_output === "string") {
    return item.aggregated_output;
  }
  if (typeof item.aggregatedOutput === "string") {
    return item.aggregatedOutput;
  }
  return "";
}

function normalizeItemStatus(statusRaw, completed) {
  if (typeof statusRaw !== "string" || !statusRaw) {
    return completed ? "completed" : "inProgress";
  }

  switch (statusRaw) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "declined":
    case "denied":
    case "cancelled":
    case "canceled":
      return "declined";
    default:
      return completed ? "completed" : "inProgress";
  }
}

function toneForStatus(status) {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "declined":
      return "error";
    default:
      return "running";
  }
}

function colorClassForTone(tone) {
  switch (tone) {
    case "success":
      return "cli-success";
    case "error":
      return "cli-error";
    default:
      return "cli-meta";
  }
}

function commandTextFromItem(item) {
  if (typeof item?.command === "string" && item.command.trim()) {
    return item.command.trim();
  }
  return "(unknown command)";
}

function cwdTextFromItem(item) {
  if (typeof item?.cwd === "string" && item.cwd.trim()) {
    return item.cwd.trim();
  }
  return "";
}

function exitCodeFromItem(item) {
  const value = item?.exit_code ?? item?.exitCode;
  return typeof value === "number" ? value : null;
}

function durationFromItem(item) {
  const value = item?.duration_ms ?? item?.durationMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "";
  }
  return formatDurationMs(value);
}

function formatDurationMs(durationMs) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1000;
    return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  }
  if (durationMs < 3_600_000) {
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function buildFileChangeDetails(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return [];
  }

  const lines = [];
  const maxLines = 6;
  for (const change of changes.slice(0, maxLines)) {
    const path = typeof change?.path === "string" && change.path ? change.path : "(unknown)";
    const { code, klass } = fileChangeKindMarker(change?.kind);
    lines.push([seg("  └ ", "cli-meta"), seg(code, klass), seg(" ", "cli-meta"), seg(path, "cli-meta")]);
  }
  if (changes.length > maxLines) {
    lines.push([seg(`    … +${changes.length - maxLines} files`, "cli-meta")]);
  }
  return lines;
}

function fileChangeKindMarker(kindRaw) {
  switch (kindRaw) {
    case "added":
      return { code: "A", klass: "cli-success" };
    case "deleted":
      return { code: "D", klass: "cli-error" };
    case "renamed":
      return { code: "R", klass: "cli-info" };
    case "modified":
      return { code: "M", klass: "cli-error" };
    default:
      return { code: "M", klass: "cli-error" };
  }
}

function setSegmentLine(container, segments) {
  setSegmentLines(container, [segments]);
}

function setSegmentLines(container, lines) {
  container.innerHTML = "";
  if (!Array.isArray(lines) || lines.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const segments of lines) {
    const row = document.createElement("div");
    row.className = "cli-line";
    appendSegments(row, segments);
    container.append(row);
  }
}

function appendSegments(container, segments) {
  for (const segment of segments) {
    const value = normalizeSegment(segment);
    if (!value.text) {
      continue;
    }
    const span = document.createElement("span");
    span.textContent = value.text;
    if (value.className) {
      span.className = value.className;
    }
    container.append(span);
  }
}

function normalizeSegment(segment) {
  if (typeof segment === "string") {
    return { className: "", text: segment };
  }
  if (!segment || typeof segment !== "object") {
    return { className: "", text: "" };
  }
  const text = typeof segment.text === "string" ? segment.text : String(segment.text ?? "");
  const className = typeof segment.className === "string" ? segment.className : "";
  return { className, text };
}

function seg(text, className = "") {
  return { className, text };
}

function formatElapsedCompact(elapsedSeconds) {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  if (elapsedSeconds < 3600) {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function statusToneForHeader(header) {
  const value = typeof header === "string" ? header.toLowerCase() : "";
  if (value.includes("interrupt")) {
    return "error";
  }
  if (value.includes("command")) {
    return "command";
  }
  if (value.includes("patch")) {
    return "info";
  }
  return "working";
}
