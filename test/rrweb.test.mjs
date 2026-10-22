import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decodeSnapshots, digest, opensOutsidePage } from "../lib/rrweb.mjs";
import { buildTimeline, linesByNumber } from "../lib/timeline.mjs";
import { redact } from "../lib/redact.mjs";
import { recording, posthogJsonl, T0 } from "./fixtures.mjs";

const lines = () => digest(recording()).map((l) => `${l.kind}: ${l.text}`);

describe("decodeSnapshots", () => {
  test("reads PostHog's JSON lines with gzip-in-latin-1 payloads", () => {
    const events = decodeSnapshots(posthogJsonl());
    assert.equal(events.length, recording().length);
    assert.equal(events.find((e) => e.type === 2).data.node.id, 1);
    assert.ok(events.every((e) => !e.cv), "compression markers removed");
    assert.deepEqual(digest(events), digest(recording()), "same digest as the uncompressed recording");
  });

  test("a recording cut mid-line still yields everything before the cut", () => {
    const text = posthogJsonl();
    const events = decodeSnapshots(text.slice(0, text.lastIndexOf("\n") + 20));
    assert.equal(events.length, recording().length - 1);
  });

  test("accepts a plain JSON array of events", () => {
    assert.equal(decodeSnapshots(JSON.stringify(recording())).length, recording().length);
  });
});

describe("digest", () => {
  test("a button that changes nothing is reported as such", () => {
    const all = lines();
    const i = all.findIndex((l) => l.startsWith('click: tap button "Create workspace"'));
    assert.ok(i >= 0, all.join("\n"));
    assert.equal(all[i + 1], "screen: no visible change after the click");
  });

  test("typing is reported by field and length, never content", () => {
    assert.ok(lines().includes('type: typed in input "placeholder: Workspace name" (7 chars, masked)'));
    assert.ok(!lines().some((l) => l.includes("*****")));
  });

  // A value the page set on a field without focus is not the person typing.
  // Counting it once hid a dialog behind two phantom "typed" lines.
  test("a value set by the page is not typing", () => {
    assert.ok(!lines().some((l) => l.includes("Credits to buy")));
  });

  test("a dialog that opens after a click is quoted", () => {
    assert.ok(lines().includes("screen: dialog: Your file is ready. This translation uses 6,950 credits."));
  });

  test("a chosen file says so, without its path", () => {
    assert.ok(lines().includes('type: chose a file in input "Choose a file"'));
    assert.ok(!lines().some((l) => l.includes("fakepath")));
  });

  test("console errors, idle gaps and page loads appear", () => {
    const all = lines();
    assert.ok(all.includes('console: error: "TypeError: Failed to fetch"'));
    assert.ok(all.some((l) => /^idle: no activity for 4\ds$/.test(l)), all.join("\n"));
    assert.ok(all[0].startsWith("nav: page https://app.example.com/onboarding (360x640)"));
  });

  // A tap in a text field changing nothing is normal: only action controls are flagged.
  test("a tap in a field is not flagged as a dead click", () => {
    const events = recording();
    events.splice(2, 1, { type: 3, timestamp: T0 + 4000, data: { source: 2, type: 9, id: 11 } });
    const all = digest(events).map((l) => `${l.kind}: ${l.text}`);
    assert.ok(!all.includes("screen: no visible change after the click"), all.join("\n"));
  });
});

describe("timeline", () => {
  test("numbered, redacted, and lines come back by number", () => {
    const t = buildTimeline({
      id: "s1",
      events: recording(),
      productEvents: [
        { event: "upgrade_prompt_viewed", t: T0 + 10_500, props: { credits_needed: 6950, credits_balance: 0 } },
        { event: "upgrade_prompt_viewed", t: T0 + 10_600, props: { credits_needed: 6950, credits_balance: 0 } },
      ],
    });
    assert.match(t.text, /event {3}upgrade_prompt_viewed \(credits_needed=6950 credits_balance=0\)/);
    assert.equal(t.text.match(/upgrade_prompt_viewed/g).length, 1, "a repeat with the same facts is dropped");
    assert.ok(!t.text.includes("ada@example.com"), "emails are redacted");
    const byNumber = linesByNumber(t.text);
    assert.equal(byNumber.size, t.lines.length);
    assert.match(byNumber.get(1), /^00:00 nav page https:\/\/app\.example\.com\/onboarding/);
  });

  test("an empty recording gives no timeline", () => {
    assert.equal(buildTimeline({ id: "x", events: [] }), null);
  });
});

describe("redact", () => {
  test("emails, long numbers and URL tokens", () => {
    assert.equal(redact("mail ada@example.com"), "mail <email>");
    assert.equal(redact("call +33 6 12 34 56 78"), "call <number>");
    assert.equal(redact("https://app.example.com/claim/aigq_o8Y6vlFEVYH4JzgfQG5Y"), "https://app.example.com/claim/<token>");
    assert.equal(redact("/login?next=%2F&token=abc123"), "/login?next=%2F&token=<token>");
  });

  test("leaves ordinary numbers alone", () => {
    assert.equal(redact("This translation uses 6,950 credits"), "This translation uses 6,950 credits");
  });
});

describe("controls whose effect a recording cannot show", () => {
  test("file pickers, downloads and copies are recognised, in several languages", () => {
    for (const label of ['button "Choose another file"', 'button "Start over with another file"', 'button "Download translation"', 'button "Elegir un archivo"', 'a "Télécharger"', 'button "Copy link"']) {
      assert.equal(opensOutsidePage(label), true, label);
    }
  });
  test("ordinary buttons are not", () => {
    for (const label of ['button "Create workspace"', 'button "Back to dashboard"', 'button "Translate entire book"']) {
      assert.equal(opensOutsidePage(label), false, label);
    }
  });
});
