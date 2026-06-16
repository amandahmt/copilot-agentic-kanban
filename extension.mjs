import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const boardRoot = path.join(extensionRoot, "artifacts", "boards");
const DEFAULT_BOARD_ID = "default";
const DEFAULT_COLUMNS = [
    { id: "todo", title: "Todo" },
    { id: "doing", title: "Doing" },
    { id: "done", title: "Done" },
];

const instances = new Map();
const boardLocks = new Map();

function safeBoardId(input) {
    const candidate = typeof input?.boardId === "string" ? input.boardId.trim() : DEFAULT_BOARD_ID;
    const boardId = candidate || DEFAULT_BOARD_ID;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(boardId)) {
        throw new CanvasError("invalid_board_id", "boardId must match [a-zA-Z0-9._-]{1,64}");
    }
    return boardId;
}

function boardFile(boardId) {
    return path.join(boardRoot, `${boardId}.json`);
}

function nowIso() {
    return new Date().toISOString();
}

function createEmptyBoard(boardId) {
    return {
        boardId,
        title: boardId === DEFAULT_BOARD_ID ? "Agentic Kanban" : boardId,
        columns: DEFAULT_COLUMNS.map((c) => ({ ...c, cards: [] })),
        updatedAt: nowIso(),
    };
}

async function loadBoard(boardId) {
    const file = boardFile(boardId);
    try {
        const raw = await readFile(file, "utf8");
        return JSON.parse(raw);
    } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
            const board = createEmptyBoard(boardId);
            await saveBoard(board);
            return board;
        }
        throw error;
    }
}

async function saveBoard(board) {
    await mkdir(boardRoot, { recursive: true });
    board.updatedAt = nowIso();
    const file = boardFile(board.boardId);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(board, null, 2), "utf8");
    await rename(temp, file);
}

function boardSummary(board) {
    const counts = board.columns.map((c) => `${c.title}: ${c.cards.length}`).join(" | ");
    return `${board.title} (${counts})`;
}

function locateCard(board, cardId) {
    for (const column of board.columns) {
        const index = column.cards.findIndex((card) => card.id === cardId);
        if (index >= 0) {
            return { column, index, card: column.cards[index] };
        }
    }
    return null;
}

function ensureColumn(board, columnId) {
    const column = board.columns.find((c) => c.id === columnId);
    if (!column) {
        throw new CanvasError("column_not_found", `Column '${columnId}' was not found.`);
    }
    return column;
}

async function withBoardLock(boardId, fn) {
    const previous = boardLocks.get(boardId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise((resolve) => {
        release = resolve;
    });
    boardLocks.set(boardId, previous.then(() => current));
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (boardLocks.get(boardId) === current) {
            boardLocks.delete(boardId);
        }
    }
}

async function mutateBoard(boardId, mutator) {
    return withBoardLock(boardId, async () => {
        const board = await loadBoard(boardId);
        const result = await mutator(board);
        await saveBoard(board);
        await broadcastBoard(boardId, board);
        return result ?? board;
    });
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, value) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
}

function sanitize(input) {
    return String(input ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function renderHtml(boardId) {
    const escapedBoardId = sanitize(boardId);
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentic Kanban</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--font-sans, -apple-system, Segoe UI, sans-serif);
      background: var(--background-color-default, #fff);
      color: var(--text-color-default, #1f2328);
    }
    .wrap { padding: 12px; display: grid; gap: 10px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, textarea, select, button {
      border: 1px solid var(--border-color-default, #d1d9e0);
      border-radius: 6px;
      background: var(--background-color-default, #fff);
      color: inherit;
      font: inherit;
      padding: 6px 8px;
    }
    .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .column {
      border: 1px solid var(--border-color-default, #d1d9e0);
      border-radius: 8px;
      padding: 8px;
      min-height: 200px;
      background: color-mix(in srgb, var(--background-color-default, #fff), #000 2%);
    }
    .card {
      border: 1px solid var(--border-color-default, #d1d9e0);
      border-radius: 8px;
      padding: 8px;
      margin-bottom: 8px;
      background: var(--background-color-default, #fff);
    }
    .meta { color: var(--text-color-muted, #636c76); font-size: 12px; }
    .card-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
    textarea { min-width: 260px; min-height: 52px; }
    .status { color: var(--text-color-muted, #636c76); }
    .error { color: var(--true-color-red, #d1242f); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <strong id="title">Agentic Kanban</strong>
      <span class="status" id="status">Loading...</span>
    </div>
    <div class="toolbar">
      <input id="cardTitle" placeholder="Card title" />
      <textarea id="cardDescription" placeholder="Card details / task prompt seed"></textarea>
      <button id="addCard">Add card</button>
      <span class="error" id="error"></span>
    </div>
    <div class="board" id="board"></div>
  </div>
  <script>
    const boardId = "${escapedBoardId}";
    let boardState = null;
    const boardEl = document.getElementById("board");
    const titleEl = document.getElementById("title");
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");

    function setError(message = "") { errorEl.textContent = message; }

    async function call(path, method = "GET", body) {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || ("HTTP " + res.status));
      return data;
    }

    function renderCard(card, columnId) {
      const div = document.createElement("div");
      div.className = "card";
      const created = new Date(card.createdAt).toLocaleString();
      div.innerHTML = \`
        <div><strong>\${card.title}</strong></div>
        <div class="meta">\${card.description || ""}</div>
        <div class="meta">Created: \${created}</div>
        <div class="meta">Last kickoff: \${card.lastKickoffAt ? new Date(card.lastKickoffAt).toLocaleString() : "Never"}</div>
        <div class="card-actions">
          <button data-action="move" data-card="\${card.id}" data-from="\${columnId}" data-to="todo">Todo</button>
          <button data-action="move" data-card="\${card.id}" data-from="\${columnId}" data-to="doing">Doing</button>
          <button data-action="move" data-card="\${card.id}" data-from="\${columnId}" data-to="done">Done</button>
          <button data-action="kickoff" data-card="\${card.id}">Kick off task</button>
        </div>
      \`;
      return div;
    }

    function renderBoard(state) {
      boardState = state;
      titleEl.textContent = state.title;
      statusEl.textContent = "Updated " + new Date(state.updatedAt).toLocaleTimeString();
      boardEl.replaceChildren();
      for (const column of state.columns) {
        const section = document.createElement("section");
        section.className = "column";
        const heading = document.createElement("h3");
        heading.textContent = \`\${column.title} (\${column.cards.length})\`;
        section.appendChild(heading);
        for (const card of column.cards) {
          section.appendChild(renderCard(card, column.id));
        }
        boardEl.appendChild(section);
      }
    }

    boardEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      setError();
      try {
        if (target.dataset.action === "move") {
          await call("/api/move", "POST", {
            boardId,
            cardId: target.dataset.card,
            toColumnId: target.dataset.to,
          });
          return;
        }
        if (target.dataset.action === "kickoff") {
          await call("/api/kickoff", "POST", {
            boardId,
            cardId: target.dataset.card,
          });
          return;
        }
      } catch (error) {
        setError(error.message || "Action failed");
      }
    });

    document.getElementById("addCard").addEventListener("click", async () => {
      const title = document.getElementById("cardTitle").value.trim();
      const description = document.getElementById("cardDescription").value.trim();
      setError();
      if (!title) {
        setError("Title is required.");
        return;
      }
      try {
        await call("/api/cards", "POST", {
          boardId,
          title,
          description,
          columnId: "todo",
        });
        document.getElementById("cardTitle").value = "";
        document.getElementById("cardDescription").value = "";
      } catch (error) {
        setError(error.message || "Could not add card");
      }
    });

    async function init() {
      renderBoard(await call("/api/state?boardId=" + encodeURIComponent(boardId)));
      const events = new EventSource("/events?boardId=" + encodeURIComponent(boardId));
      events.onmessage = (event) => {
        try { renderBoard(JSON.parse(event.data)); } catch {}
      };
      events.onerror = () => { statusEl.textContent = "Reconnecting..."; };
    }

    init().catch((error) => setError(error.message || "Init failed"));
  </script>
</body>
</html>`;
}

async function kickoffTask(boardId, cardId, prompt) {
    const result = await mutateBoard(boardId, async (board) => {
        const location = locateCard(board, cardId);
        if (!location) {
            throw new CanvasError("card_not_found", `Card '${cardId}' was not found.`);
        }
        const finalPrompt =
            typeof prompt === "string" && prompt.trim()
                ? prompt.trim()
                : [
                      `Start working on this kanban task from board '${boardId}':`,
                      `Title: ${location.card.title}`,
                      `Details: ${location.card.description || "(none)"}`,
                      "Proceed autonomously and report meaningful progress.",
                  ].join("\n");
        await session.send(finalPrompt);
        location.card.lastKickoffAt = nowIso();
        return { ok: true, cardId: location.card.id, prompt: finalPrompt };
    });
    return result;
}

async function broadcastBoard(boardId, boardOverride) {
    const board = boardOverride ?? (await loadBoard(boardId));
    const payload = `data: ${JSON.stringify(board)}\n\n`;
    for (const entry of instances.values()) {
        if (entry.boardId !== boardId) continue;
        for (const client of entry.sseClients) {
            client.write(payload);
        }
    }
}

function notFound(res) {
    sendJson(res, 404, { error: "Not found" });
}

async function startServer(instanceId, boardId) {
    const sseClients = new Set();
    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        try {
            if (req.method === "GET" && url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml(boardId));
                return;
            }
            if (req.method === "GET" && url.pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });
                sseClients.add(res);
                const board = await loadBoard(boardId);
                res.write(`data: ${JSON.stringify(board)}\n\n`);
                req.on("close", () => sseClients.delete(res));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/state") {
                sendJson(res, 200, await loadBoard(boardId));
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/cards") {
                const input = await readJson(req);
                if (!input.title || !String(input.title).trim()) {
                    throw new CanvasError("invalid_title", "title is required");
                }
                const result = await mutateBoard(boardId, async (board) => {
                    const columnId = typeof input.columnId === "string" ? input.columnId : "todo";
                    const column = ensureColumn(board, columnId);
                    const card = {
                        id: randomUUID(),
                        title: String(input.title).trim(),
                        description: String(input.description ?? "").trim(),
                        createdAt: nowIso(),
                        lastKickoffAt: null,
                    };
                    column.cards.unshift(card);
                    return { ok: true, card };
                });
                sendJson(res, 200, result);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/move") {
                const input = await readJson(req);
                const result = await mutateBoard(boardId, async (board) => {
                    const cardId = String(input.cardId ?? "").trim();
                    const toColumnId = String(input.toColumnId ?? "").trim();
                    if (!cardId || !toColumnId) {
                        throw new CanvasError("invalid_move", "cardId and toColumnId are required");
                    }
                    const location = locateCard(board, cardId);
                    if (!location) {
                        throw new CanvasError("card_not_found", `Card '${cardId}' was not found.`);
                    }
                    const target = ensureColumn(board, toColumnId);
                    const [card] = location.column.cards.splice(location.index, 1);
                    const insertIndex = Number.isInteger(input.index)
                        ? Math.max(0, Math.min(input.index, target.cards.length))
                        : target.cards.length;
                    target.cards.splice(insertIndex, 0, card);
                    return { ok: true, cardId, toColumnId };
                });
                sendJson(res, 200, result);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/kickoff") {
                const input = await readJson(req);
                const cardId = String(input.cardId ?? "").trim();
                if (!cardId) throw new CanvasError("invalid_kickoff", "cardId is required");
                sendJson(res, 200, await kickoffTask(boardId, cardId, input.prompt));
                return;
            }
            notFound(res);
        } catch (error) {
            if (error instanceof CanvasError) {
                sendJson(res, 400, { error: error.message, code: error.code });
                return;
            }
            sendJson(res, 500, { error: "Internal error" });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, sseClients, boardId };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "agentic-kanban",
            displayName: "Agentic Kanban",
            description: "Local board where you and agents add cards, move work, and kick off tasks.",
            inputSchema: {
                type: "object",
                properties: {
                    boardId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9._-]+$" },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "get_board",
                    description: "Read the current kanban board state.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            boardId: { type: "string" },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        return loadBoard(safeBoardId(ctx.input));
                    },
                },
                {
                    name: "add_card",
                    description: "Create a new card on the board.",
                    inputSchema: {
                        type: "object",
                        required: ["title"],
                        properties: {
                            boardId: { type: "string" },
                            title: { type: "string", minLength: 1, maxLength: 200 },
                            description: { type: "string", maxLength: 4000 },
                            columnId: { type: "string", enum: ["todo", "doing", "done"] },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const boardId = safeBoardId(ctx.input);
                        return mutateBoard(boardId, async (board) => {
                            const title = String(ctx.input.title).trim();
                            if (!title) throw new CanvasError("invalid_title", "title is required");
                            const column = ensureColumn(board, ctx.input.columnId ?? "todo");
                            const card = {
                                id: randomUUID(),
                                title,
                                description: String(ctx.input.description ?? "").trim(),
                                createdAt: nowIso(),
                                lastKickoffAt: null,
                            };
                            column.cards.unshift(card);
                            return { ok: true, card };
                        });
                    },
                },
                {
                    name: "move_card",
                    description: "Move a card between columns.",
                    inputSchema: {
                        type: "object",
                        required: ["cardId", "toColumnId"],
                        properties: {
                            boardId: { type: "string" },
                            cardId: { type: "string" },
                            toColumnId: { type: "string", enum: ["todo", "doing", "done"] },
                            index: { type: "integer", minimum: 0 },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const boardId = safeBoardId(ctx.input);
                        return mutateBoard(boardId, async (board) => {
                            const location = locateCard(board, ctx.input.cardId);
                            if (!location) {
                                throw new CanvasError("card_not_found", `Card '${ctx.input.cardId}' was not found.`);
                            }
                            const target = ensureColumn(board, ctx.input.toColumnId);
                            const [card] = location.column.cards.splice(location.index, 1);
                            const targetIndex = Number.isInteger(ctx.input.index)
                                ? Math.max(0, Math.min(ctx.input.index, target.cards.length))
                                : target.cards.length;
                            target.cards.splice(targetIndex, 0, card);
                            return { ok: true, cardId: card.id, toColumnId: target.id };
                        });
                    },
                },
                {
                    name: "kickoff_task",
                    description: "Kick off an agent task from a card and mark kickoff time.",
                    inputSchema: {
                        type: "object",
                        required: ["cardId"],
                        properties: {
                            boardId: { type: "string" },
                            cardId: { type: "string" },
                            prompt: { type: "string", maxLength: 8000 },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        return kickoffTask(safeBoardId(ctx.input), ctx.input.cardId, ctx.input.prompt);
                    },
                },
            ],
            open: async (ctx) => {
                const boardId = safeBoardId(ctx.input);
                let entry = instances.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, boardId);
                    instances.set(ctx.instanceId, entry);
                } else if (entry.boardId !== boardId) {
                    for (const client of entry.sseClients) client.end();
                    await new Promise((resolve) => entry.server.close(resolve));
                    entry = await startServer(ctx.instanceId, boardId);
                    instances.set(ctx.instanceId, entry);
                }
                const board = await loadBoard(boardId);
                return {
                    title: board.title,
                    status: boardSummary(board),
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (entry) {
                    instances.delete(ctx.instanceId);
                    for (const client of entry.sseClients) client.end();
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
