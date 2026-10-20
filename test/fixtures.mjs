// An invented rrweb recording, small enough to read, covering every kind of line
// the digest writes. No real session was used to make it.

import { gzipSync } from "node:zlib";

export const T0 = Date.UTC(2026, 9, 19, 14, 41, 0);
const at = (s) => T0 + s * 1000;

// Node ids: 1 document, 2 html, 3 body, 10 form, 11 input, 12 button, 13 its text,
// 14 file input, 15 amount field set by the app, 20 menu text with an email.
const snapshot = {
  type: 0,
  id: 1,
  childNodes: [
    {
      type: 2, id: 2, tagName: "html", attributes: {},
      childNodes: [
        {
          type: 2, id: 3, tagName: "body", attributes: {},
          childNodes: [
            { type: 2, id: 20, tagName: "span", attributes: {}, childNodes: [{ type: 3, id: 21, textContent: "Signed in as ada@example.com" }] },
            {
              type: 2, id: 10, tagName: "form", attributes: {},
              childNodes: [
                { type: 2, id: 11, tagName: "input", attributes: { name: "workspace", placeholder: "Workspace name" }, childNodes: [] },
                { type: 2, id: 12, tagName: "button", attributes: {}, childNodes: [{ type: 3, id: 13, textContent: "Create workspace" }] },
                { type: 2, id: 14, tagName: "input", attributes: { type: "file", "aria-label": "Choose a file" }, childNodes: [] },
                { type: 2, id: 15, tagName: "input", attributes: { "aria-label": "Credits to buy" }, childNodes: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const dialog = {
  type: 2, id: 30, tagName: "div", attributes: { role: "dialog" },
  childNodes: [{ type: 3, id: 31, textContent: "Your file is ready. This translation uses 6,950 credits." }],
};

export function recording() {
  return [
    { type: 4, timestamp: at(0), data: { href: "https://app.example.com/onboarding", width: 360, height: 640 } },
    { type: 2, timestamp: at(0.1), data: { node: snapshot } },
    // A tap on the button that changes nothing on screen.
    { type: 3, timestamp: at(4), data: { source: 2, type: 9, id: 13 } },
    // Focus, then typing in the name field.
    { type: 3, timestamp: at(6), data: { source: 2, type: 5, id: 11 } },
    { type: 3, timestamp: at(7), data: { source: 5, id: 11, text: "*****" } },
    { type: 3, timestamp: at(8), data: { source: 5, id: 11, text: "*******" } },
    // The app sets the amount field itself: not typing.
    { type: 3, timestamp: at(8.5), data: { source: 5, id: 15, text: "6950" } },
    // A click that opens a dialog.
    { type: 3, timestamp: at(10), data: { source: 2, type: 2, id: 12 } },
    { type: 3, timestamp: at(10.4), data: { source: 0, adds: [{ parentId: 3, nextId: null, node: dialog }], removes: [], texts: [], attributes: [] } },
    // A file chosen.
    { type: 3, timestamp: at(14), data: { source: 2, type: 2, id: 14 } },
    { type: 3, timestamp: at(16), data: { source: 5, id: 14, text: "C:\\fakepath\\catalog.csv" } },
    { type: 6, timestamp: at(17), data: { plugin: "rrweb/console@1", payload: { level: "error", payload: ['"TypeError: Failed to fetch"'] } } },
    // Forty seconds of nothing, then a scroll.
    { type: 3, timestamp: at(57), data: { source: 3, id: 1, x: 0, y: 200 } },
  ];
}

/** The same recording as PostHog's snapshot endpoint returns it: JSON lines, compressed payloads. */
export function posthogJsonl() {
  const z = (value) => gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("latin1");
  return recording()
    .map((ev) => {
      if (ev.type === 2) return ["w1", { ...ev, cv: "2024-10", data: z(ev.data) }];
      if (ev.type === 3 && ev.data.source === 0) {
        return ["w1", { ...ev, cv: "2024-10", data: { ...ev.data, adds: z(ev.data.adds), removes: z(ev.data.removes), texts: z(ev.data.texts), attributes: z(ev.data.attributes) } }];
      }
      return ["w1", ev];
    })
    .map((line) => JSON.stringify(line))
    .join("\n");
}
