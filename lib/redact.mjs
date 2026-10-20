// What could identify a person, stripped before any text leaves the machine.
//
// rrweb already masks what people type in inputs (PostHog does by default), so
// the digest never sees passwords or messages. What it does see is the text on
// screen: the signed-in user's email in a menu, an invoice number, a phone
// number in a profile. Those go before a timeline is written to disk or sent to
// a model. It is a floor, not a guarantee: names and free text on screen pass,
// so treat timelines as personal data (see SECURITY.md).

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Seven or more digits with the usual separators: phone and card-like numbers.
const LONG_NUMBER = /(?<![\w.])\+?\d[\d ().-]{6,}\d(?![\w])/g;
// Opaque tokens in URLs (claim links, reset links, magic links).
const URL_TOKEN = /([?&](?:token|code|key|secret|signature|sig|verifier|session[_-]?\w*)=)[^&#\s"]+/gi;
const PATH_TOKEN = /(\/(?:claim|invite|join|reset|verify|magic)\/)[A-Za-z0-9_-]{12,}/gi;

/** @param {unknown} value */
export function redact(value) {
  return String(value ?? "")
    .replace(EMAIL, "<email>")
    .replace(URL_TOKEN, "$1<token>")
    .replace(PATH_TOKEN, "$1<token>")
    .replace(LONG_NUMBER, "<number>");
}
