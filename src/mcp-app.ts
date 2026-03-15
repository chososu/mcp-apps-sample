/**
 * Cloud Logging Viewer MCP App
 *
 * Displays GCP Cloud Logging entries in a scrollable list.
 * Users can click entries to select them (multiple selection supported).
 * Selected entries are sent to Claude's context so the user can ask about them.
 */
import { App } from "@modelcontextprotocol/ext-apps";

const PREFERRED_INLINE_HEIGHT = 450;
const CONTEXT_DEBOUNCE_MS = 800;

interface LogEntry {
  timestamp: string;
  severity: string;
  message: string;
  resource: string;
  labels: Record<string, string>;
  logName: string;
}

interface LogData {
  projectId: string;
  startTime: string;
  endTime: string;
  startTimeJST?: string;
  endTimeJST?: string;
  severity: string;
  resourceType: string;
  textFilter: string;
  totalEntries: number;
  entries: LogEntry[];
}

const selectedIndices: Set<number> = new Set();
let currentLogData: LogData | null = null;
let contextTimer: ReturnType<typeof setTimeout> | null = null;
let lastDataHash = "";

const app = new App(
  { name: "Cloud Logging Viewer", version: "1.0.0" },
  { tools: { listChanged: true } },
  { autoResize: false },
);

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Rendering ----

function renderEntries(): void {
  const container = document.getElementById("log-container")!;
  if (!currentLogData || currentLogData.entries.length === 0) {
    container.innerHTML = '<div class="empty-state">No log entries found</div>';
    return;
  }

  container.innerHTML = currentLogData.entries
    .map((entry, i) => {
      const sel = selectedIndices.has(i) ? " selected" : "";
      const msg =
        entry.message.length > 500
          ? escapeHtml(entry.message.slice(0, 500)) + "..."
          : escapeHtml(entry.message);
      return (
        `<div class="log-entry${sel}" data-idx="${i}">` +
        `<span class="timestamp">${formatTimestamp(entry.timestamp)}</span>` +
        `<span class="severity severity-${entry.severity}">${entry.severity}</span>` +
        `<span class="message">${msg}</span>` +
        `</div>`
      );
    })
    .join("");
}

function updateFooter(): void {
  const footer = document.getElementById("footer-status")!;
  const n = selectedIndices.size;
  footer.textContent =
    n > 0
      ? `${n} entries selected — ask Claude about them in chat`
      : "Click log entries to select";
}

// ---- Selection ----

function handleEntryClick(idx: number): void {
  if (selectedIndices.has(idx)) {
    selectedIndices.delete(idx);
  } else {
    selectedIndices.add(idx);
  }

  // Update just the clicked element's class (avoid full re-render)
  const el = document.querySelector(`.log-entry[data-idx="${idx}"]`);
  if (el) {
    el.classList.toggle("selected", selectedIndices.has(idx));
  }

  updateFooter();
  scheduleContextUpdate();
}

// ---- Context update (debounced) ----

function scheduleContextUpdate(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    sendContext();
  }, CONTEXT_DEBOUNCE_MS);
}

function sendContext(): void {
  if (!currentLogData) return;

  if (selectedIndices.size === 0) {
    app.updateModelContext({
      content: [
        {
          type: "text",
          text:
            `Log viewer showing ${currentLogData.totalEntries} entries from project "${currentLogData.projectId}". ` +
            `No entries selected. The user can click entries in the viewer to select them.`,
        },
      ],
    });
    return;
  }

  const selected = Array.from(selectedIndices)
    .sort((a, b) => a - b)
    .map((i) => currentLogData!.entries[i])
    .filter(Boolean);

  const lines = selected.map(
    (e, i) =>
      `[${i + 1}] ${formatTimestamp(e.timestamp)} [${e.severity}] (${e.resource}) ${e.message}`,
  );

  app.updateModelContext({
    content: [
      {
        type: "text",
        text:
          `The user selected ${selected.length} log entries in the viewer.\n` +
          `Project: "${currentLogData.projectId}" | All times are JST (Asia/Tokyo).\n\n` +
          lines.join("\n"),
      },
    ],
  });
}

// ---- Data loading ----

function parseLogData(raw: any): LogData | null {
  try {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return null; }
    }
    if (raw?.content) {
      for (const c of (Array.isArray(raw.content) ? raw.content : [raw.content])) {
        if (c?.type === "text" && c?.text) {
          try { return JSON.parse(c.text); } catch { /* skip */ }
        }
      }
    }
    if (raw?.entries && Array.isArray(raw.entries)) return raw as LogData;
    return null;
  } catch { return null; }
}

function loadData(data: LogData): void {
  // Only reset selection if this is genuinely new data
  const hash = `${data.projectId}|${data.startTime}|${data.endTime}|${data.totalEntries}`;
  if (hash !== lastDataHash) {
    selectedIndices.clear();
    lastDataHash = hash;
  }

  currentLogData = data;

  const timeRange =
    data.startTimeJST && data.endTimeJST
      ? `${data.startTimeJST} 〜 ${data.endTimeJST} JST`
      : `${data.totalEntries} entries`;

  document.getElementById("header-title")!.textContent =
    `Cloud Logging — ${data.projectId}`;
  document.getElementById("header-info")!.textContent = timeRange;

  renderEntries();
  updateFooter();

  document.getElementById("loading")!.style.display = "none";
  document.getElementById("app")!.style.display = "flex";
}

// ---- MCP App lifecycle ----

app.ontoolinput = async (params) => {
  const data = parseLogData(params.arguments);
  if (data) loadData(data);
};

app.ontoolresult = async (result) => {
  const data = parseLogData(result);
  if (data) loadData(data);
};

app.onerror = (err) => {
  console.error("[APP]", err);
  const el = document.getElementById("loading");
  if (el) el.textContent = `Error: ${String(err)}`;
};

async function initialize() {
  await app.connect();
  app.sendSizeChanged({ height: PREFERRED_INLINE_HEIGHT });

  // Event delegation for clicks
  document.getElementById("log-container")!.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".log-entry");
    if (!row) return;
    const idx = parseInt(row.getAttribute("data-idx") ?? "-1", 10);
    if (idx >= 0) handleEntryClick(idx);
  });
}

initialize();
