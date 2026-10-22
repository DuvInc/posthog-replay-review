// Turns an rrweb recording into lines a person, or a small model, can read.
//
// A session replay is not a video. It is a DOM snapshot followed by a stream of
// mutations, clicks and inputs (rrweb, which PostHog, Highlight, OpenReplay and
// others record with). Replaying it in a browser and watching is slow and does
// not scale; sending screenshots to a vision model is expensive and loses the
// exact text on screen. This file rebuilds the DOM as a plain tree, applies the
// mutations, and writes down what happened:
//
//   click button "Create workspace"            the label of what was clicked
//   no visible change after the click          a button that did nothing visible
//   typed in input "Workspace name" (7 chars)  never the content: inputs are masked
//   dialog: Your file is ready. This uses ...  what the person was being told
//   idle: no activity for 45s                  hesitation
//   console error: Failed to fetch ...         the bugs they hit
//
// Pure: no network, no file system, no clock. Runs in Node and in a browser.
//
// rrweb constants used below. Event type: 2 full snapshot, 3 incremental,
// 4 meta, 6 plugin. Incremental source: 0 mutation, 2 mouse interaction,
// 3 scroll, 5 input. Mouse interaction type: 2 click, 5 focus, 9 touch end.

import { gunzipSync } from "node:zlib";

const SKIP = new Set(["script", "style", "head", "noscript", "svg", "template", "meta", "link"]);
const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "label", "summary"]);
const INTERACTIVE_ROLES = new Set(["button", "tab", "menuitem", "option", "link", "checkbox", "switch"]);

// PostHog compresses rrweb payloads (`cv: "2024-10"`): a gzip stream stored as
// a latin-1 string, either as the whole `data` of a snapshot or per field
// (`adds`, `removes`, `texts`, `attributes`) of a mutation.
const gunzipLatin1 = (value) => JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString("utf8"));

/**
 * Raw snapshot text -> rrweb events, sorted by time, payloads decompressed.
 *
 * Accepts what PostHog's snapshot endpoint returns (JSON lines of
 * `[windowId, event]`), JSON lines of bare events, or a JSON array of events.
 * Unparseable lines are skipped: a recording cut mid-blob still yields
 * everything before the cut.
 */
export function decodeSnapshots(text) {
  const raw = [];
  const trimmed = String(text).trim();
  if (trimmed.startsWith("[{")) {
    try {
      raw.push(...JSON.parse(trimmed));
    } catch {
      // Fall through to line by line.
    }
  }
  if (!raw.length) {
    for (const line of trimmed.split("\n")) {
      if (!line.startsWith("[") && !line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        raw.push(Array.isArray(parsed) ? parsed[1] : parsed);
      } catch {
        continue;
      }
    }
  }
  const events = [];
  for (const ev of raw) {
    if (!ev || typeof ev.timestamp !== "number") continue;
    if (ev.cv) {
      try {
        if (typeof ev.data === "string") ev.data = gunzipLatin1(ev.data);
        else if (ev.data && typeof ev.data === "object") {
          for (const key of ["texts", "attributes", "removes", "adds"]) {
            if (typeof ev.data[key] === "string") ev.data[key] = gunzipLatin1(ev.data[key]);
          }
        }
      } catch {
        continue;
      }
      delete ev.cv;
    }
    events.push(ev);
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

class Dom {
  constructor() {
    this.nodes = new Map();
    this.root = null;
  }
  add(n, parentId) {
    const node = {
      id: n.id,
      type: n.type,
      tag: (n.tagName || "").toLowerCase(),
      attrs: { ...(n.attributes || {}) },
      text: n.textContent || "",
      parent: parentId,
      kids: [],
    };
    this.nodes.set(n.id, node);
    for (const child of n.childNodes || []) node.kids.push(this.add(child, n.id).id);
    return node;
  }
  reset(root) {
    this.nodes.clear();
    this.root = this.add(root, null).id;
  }
  mutate(d) {
    for (const r of d.removes || []) this.remove(r.id, r.parentId);
    for (const a of d.adds || []) {
      if (!a?.node) continue;
      if (this.nodes.has(a.node.id)) this.remove(a.node.id, this.nodes.get(a.node.id).parent);
      const node = this.add(a.node, a.parentId);
      const parent = this.nodes.get(a.parentId);
      if (!parent) continue;
      const at = a.nextId ? parent.kids.indexOf(a.nextId) : -1;
      if (at >= 0) parent.kids.splice(at, 0, node.id);
      else parent.kids.push(node.id);
    }
    for (const t of d.texts || []) {
      const n = this.nodes.get(t.id);
      if (n) n.text = t.value ?? "";
    }
    for (const a of d.attributes || []) {
      const n = this.nodes.get(a.id);
      if (!n) continue;
      for (const [key, value] of Object.entries(a.attributes || {})) {
        if (value === null) delete n.attrs[key];
        else n.attrs[key] = typeof value === "object" ? JSON.stringify(value) : value;
      }
    }
  }
  remove(id, parentId) {
    const parent = this.nodes.get(parentId);
    if (parent) parent.kids = parent.kids.filter((k) => k !== id);
    const stack = [id];
    while (stack.length) {
      const n = this.nodes.get(stack.pop());
      if (!n) continue;
      this.nodes.delete(n.id);
      stack.push(...n.kids);
    }
  }
  hidden(n) {
    const a = n.attrs;
    return (
      a.hidden !== undefined ||
      a["aria-hidden"] === "true" ||
      /\bsr-only\b/.test(a.class || "") ||
      /display:\s*none/.test(a.style || "")
    );
  }
  /** Visible text pieces under a node, in DOM order. */
  texts(id = this.root, out = []) {
    const n = this.nodes.get(id);
    if (!n || SKIP.has(n.tag) || (n.type === 2 && this.hidden(n))) return out;
    if (n.type === 3) {
      const t = n.text.replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    for (const k of n.kids) this.texts(k, out);
    return out;
  }
  /**
   * A short label for a clicked or typed-in element: its accessible name, or
   * the text of the nearest interactive ancestor. A click usually lands on an
   * icon or a span inside the button, which says nothing on its own.
   */
  label(id) {
    let n = this.nodes.get(id);
    for (let hops = 0; n && hops < 6; hops++, n = this.nodes.get(n.parent)) {
      if (n.type !== 2) continue;
      const a = n.attrs;
      // A placeholder is an example text, not a name and never what the person
      // typed: it is marked so a reader cannot take "Describe the output" for a
      // typed answer (a survey rejection was misread that way).
      const own =
        a["aria-label"] || a.title || a.alt || (a.placeholder ? `placeholder: ${a.placeholder}` : "") || a.name;
      const txt = this.texts(n.id).join(" ").slice(0, 70);
      const interactive = INTERACTIVE.has(n.tag) || INTERACTIVE_ROLES.has(a.role);
      if (own || (interactive && txt)) return `${n.tag}${a.role ? `[${a.role}]` : ""} "${own || txt}"`;
      if (hops >= 3 && txt) return `${n.tag} "${txt}"`;
    }
    return n ? n.tag || "node" : "unknown element";
  }
  /** Text in open dialogs, alerts, toasts and invalid fields: what the person is being told. */
  overlays() {
    const out = [];
    for (const n of this.nodes.values()) {
      if (n.type !== 2) continue;
      const a = n.attrs;
      const isOverlay =
        a.role === "dialog" ||
        a.role === "alertdialog" ||
        a.role === "alert" ||
        a["data-sonner-toast"] !== undefined ||
        a["aria-invalid"] === "true";
      if (!isOverlay) continue;
      const t = this.texts(n.id).join(" ");
      if (t) out.push(`${a.role || "toast"}: ${t}`);
    }
    return out;
  }
}

/** Milliseconds -> "mm:ss". */
export const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const FILE_WORD = /\b(file|files|archivo|archivos|arquivo|arquivos|fichier|fichiers|datei|dateien)\b/i;
const FILE_ACTION = /\b(choose|browse|select|pick|upload|another|start over|replace|elegir|seleccionar|subir|escolher|enviar|choisir|parcourir|auswählen|hochladen)\b/i;
const DOWNLOAD_ACTION = /\b(download|export|copy|descargar|exportar|copiar|baixar|télécharger|exporter|copier|herunterladen|kopieren)\b/i;

/** A control whose effect (a file picker, a saved file, the clipboard) a recording cannot show. */
export const opensOutsidePage = (label) =>
  DOWNLOAD_ACTION.test(label) || (FILE_ACTION.test(label) && FILE_WORD.test(label));

export const DIGEST_DEFAULTS = Object.freeze({
  /** Gap between two inputs reported as an idle line. */
  idleMs: 15_000,
  /** How long after an action the screen is read for what appeared. */
  settleMs: 1_500,
  /** Longest "screen" line kept. */
  screenMax: 400,
});

/**
 * rrweb events -> `{ t, kind, text }[]`, with absolute timestamps in ms.
 *
 * kinds: nav, click, type, screen, idle, console.
 */
export function digest(events, options = {}) {
  const { idleMs, settleMs, screenMax } = { ...DIGEST_DEFAULTS, ...options };
  const dom = new Dom();
  const lines = [];
  let seen = new Map(); // text piece -> how many times it was on screen at the last read
  let readAt = null; // when to read the screen for what appeared
  let afterAction = false; // whether that read follows a click on an action control
  let lastOverlay = "";
  let lastActive = null;
  let typing = null;
  let focused = null;

  const push = (t, kind, text) => lines.push({ t, kind, text });
  const flushTyping = () => {
    if (typing) push(typing.t, "type", `typed in ${typing.label} (${typing.len} chars, masked)`);
    typing = null;
  };
  const readScreen = (t) => {
    const now = new Map();
    for (const piece of dom.texts()) now.set(piece, (now.get(piece) || 0) + 1);
    const fresh = [];
    for (const [piece, count] of now) if (count > (seen.get(piece) || 0)) fresh.push(piece);
    seen = now;
    const overlay = dom.overlays().join(" | ");
    if (overlay && overlay !== lastOverlay) push(t, "screen", overlay.slice(0, screenMax));
    else if (fresh.length) push(t, "screen", `new on screen: ${fresh.join(" · ")}`.slice(0, screenMax));
    else if (afterAction === "outside") push(t, "screen", "no visible change after the click (this control opens a file picker, saves a file or copies, which a recording cannot show)");
    else if (afterAction) push(t, "screen", "no visible change after the click");
    lastOverlay = overlay;
    afterAction = false;
  };

  for (const ev of events) {
    const t = ev.timestamp;
    if (readAt !== null && t >= readAt) {
      readScreen(readAt);
      readAt = null;
    }
    if (ev.type === 4) {
      flushTyping();
      push(t, "nav", `page ${ev.data?.href ?? "?"} (${ev.data?.width ?? "?"}x${ev.data?.height ?? "?"})`);
    } else if (ev.type === 2) {
      if (!ev.data?.node) continue;
      dom.reset(ev.data.node);
      seen = new Map();
      readAt = t + settleMs;
    } else if (ev.type === 6 && ev.data?.plugin === "rrweb/console@1") {
      const p = ev.data.payload || {};
      if (p.level === "error" || p.level === "warn") {
        push(t, "console", `${p.level}: ${(p.payload || []).join(" ").slice(0, 200)}`);
      }
    } else if (ev.type === 3) {
      const d = ev.data || {};
      if (d.source === 0) dom.mutate(d);
      if (d.source === 2 || d.source === 3 || d.source === 5) {
        if (lastActive !== null && t - lastActive > idleMs) {
          push(lastActive + 1, "idle", `no activity for ${Math.round((t - lastActive) / 1000)}s`);
        }
        lastActive = t;
      }
      if (d.source === 2 && (d.type === 2 || d.type === 9)) {
        focused = d.id;
        const label = dom.label(d.id);
        const prev = lines[lines.length - 1];
        // A touch end and a click fire together on mobile: keep one.
        if (!(prev && prev.kind === "click" && t - prev.t < 600 && prev.text.endsWith(label))) {
          flushTyping();
          push(t, "click", `${d.type === 9 ? "tap" : "click"} ${label}`);
        }
        readAt = t + settleMs;
        // Only an action control is expected to change the screen. A tap in a
        // text field changing nothing is normal, and reporting it buried the
        // buttons that really did nothing under noise.
        afterAction = /^(button|a\b|\w+\[(button|tab|menuitem|option|link)\])/.test(label);
        if (afterAction && opensOutsidePage(label)) afterAction = "outside";
      } else if (d.source === 2 && d.type === 5) {
        focused = d.id;
      } else if (d.source === 5 && typeof d.text === "string" && d.id === focused) {
        // An input event on a field without focus is the page setting a value
        // itself (a prefilled amount, a recalculated total), not the person
        // typing. Recordings do not reliably carry rrweb's `userTriggered`, so
        // focus is the test: counting those as typing once hid a dialog behind
        // two phantom "typed" lines.
        const node = dom.nodes.get(d.id);
        const label = dom.label(d.id);
        if (node?.attrs?.type === "file") {
          if (d.text) push(t, "type", `chose a file in ${label}`);
          continue;
        }
        if (typing && typing.label !== label) flushTyping();
        typing = { t: typing?.t ?? t, label, len: d.text.length };
      }
    }
  }
  flushTyping();
  if (readAt !== null) readScreen(readAt);
  return lines.sort((a, b) => a.t - b.t);
}
