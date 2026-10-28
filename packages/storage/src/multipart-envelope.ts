/**
 * Detection + repair of the MONEY-1169 multipart-envelope corruption.
 *
 * ## What the corruption is
 *
 * Every non-resumable upload in @google-cloud/storage v7 is a
 * `uploadType=multipart` request whose body is built by hand
 * (`--<uuid>\r\nContent-Type: application/json\r\n\r\n<metadata>\r\n--<uuid>\r\n
 * Content-Type: <media type>\r\n\r\n<PAYLOAD>\r\n--<uuid>--`). Inside the
 * workers Docker image — and only there — the transport underneath that writer
 * resolves a DIFFERENT major version of node-fetch than everywhere else,
 * because the image overlays `workers/node_modules` (which carries
 * node-fetch@3) on top of the root `node_modules` (node-fetch@2, the version
 * the transport is written against). The request reaches GCS in a form it
 * treats as a plain media upload, so the WHOLE multipart body — boundary
 * lines, metadata JSON and all — is stored verbatim as the object's content,
 * and no metadata (not even contentType) is applied.
 *
 * The write-time alarm for exactly this — CRC32C validation failing with
 * "the uploaded data did not match the data from the server" — had been
 * switched off as "spurious". It was not spurious.
 *
 * ## Why this module exists
 *
 * The payload inside a corrupt object is INTACT, byte for byte, between the
 * second boundary's blank line and the closing boundary. So the 23k+ objects
 * written through the broken path are repairable in place, with zero exchange
 * traffic. This module is the pure half of that repair: given the stored
 * bytes, return the original payload and the metadata the writer intended.
 *
 * Everything here is Buffer-only. The payloads include ZIPs and PDFs;
 * converting to string to search would corrupt them a second time.
 */

/** The exact preamble teeny-request writes before the media part's headers. */
const CRLF = Buffer.from("\r\n");
const HEADER_SEP = Buffer.from("\r\n\r\n");
const CONTENT_TYPE = Buffer.from("Content-Type:");

/** Metadata recovered from the envelope, as the original writer intended it. */
export interface StrippedEnvelope {
  /** The original payload bytes, exactly as fetched from the exchange. */
  payload: Buffer;
  /** The media part's declared Content-Type, e.g. `text/csv`. */
  contentType?: string;
  /** `cacheControl` from the metadata JSON part, when parseable. */
  cacheControl?: string;
  /** How many envelopes were peeled (1 in practice; >1 tolerated). */
  layers: number;
}

/**
 * Does this buffer START with a multipart envelope?
 *
 * Deliberately strict — all three conditions must hold at fixed offsets:
 *   1. bytes 0-1 are `--`
 *   2. a CRLF terminates the boundary token within 120 bytes (the boundary is
 *      a 36-char UUID, so the real distance is 38)
 *   3. `Content-Type:` immediately follows that CRLF
 *
 * A CSV that happens to begin with `--`, or a file of dashes, fails (2)/(3).
 * Checking AT OFFSETS rather than scanning is the lesson of this bug: the
 * old payload validation scanned 8KB for header tokens and was satisfied by
 * the token appearing INSIDE the envelope.
 */
export function isMultipartEnvelope(buf: Buffer): boolean {
  if (buf.length < 48) return false;
  if (buf[0] !== 0x2d || buf[1] !== 0x2d) return false;

  const firstCrlf = buf.indexOf(CRLF);
  if (firstCrlf <= 2 || firstCrlf > 120) return false;

  return buf
    .subarray(firstCrlf + 2, firstCrlf + 2 + CONTENT_TYPE.length)
    .equals(CONTENT_TYPE);
}

/**
 * Strip the envelope(s) and recover the payload + intended metadata.
 *
 * Returns null when `buf` is not an envelope (i.e. the object is clean) or
 * when the structure is malformed in a way that makes a byte-exact recovery
 * uncertain — the caller must then leave the object alone rather than guess.
 *
 * Structure handled (verified against real corrupt objects, including the
 * closing `\r\n--<boundary>--` finale with no trailing newline):
 *
 *   --B\r\nContent-Type: application/json\r\n\r\n{meta}\r\n
 *   --B\r\nContent-Type: <media>\r\n\r\n<PAYLOAD>\r\n--B--
 *
 * The closing boundary is found with lastIndexOf so payload bytes that happen
 * to contain `--` sequences cannot truncate it; a UUID boundary colliding with
 * payload content is astronomically unlikely, and the caller's magic-byte
 * verification catches even that.
 */
export function stripMultipartEnvelope(buf: Buffer): StrippedEnvelope | null {
  let payload = buf;
  let contentType: string | undefined;
  let cacheControl: string | undefined;
  let layers = 0;

  while (isMultipartEnvelope(payload)) {
    // A second wrap has never been observed; the loop guard is cheap insurance
    // against a hypothetical repair-of-a-repair, not an expected case.
    if (layers >= 4) return null;

    const firstCrlf = payload.indexOf(CRLF);
    const boundary = payload.subarray(0, firstCrlf); // "--<uuid>"

    // The metadata JSON sits between the first blank line and the second
    // boundary. Parse it for cacheControl/contentType; tolerate failure —
    // the media part's own header is the better contentType source anyway.
    const metaHeaderEnd = payload.indexOf(HEADER_SEP, firstCrlf);
    if (metaHeaderEnd === -1) return null;

    const secondBoundary = payload.indexOf(boundary, metaHeaderEnd);
    if (secondBoundary === -1) return null;

    const metaRaw = payload
      .subarray(metaHeaderEnd + HEADER_SEP.length, secondBoundary)
      .toString("utf-8")
      .trim();
    try {
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      if (typeof meta.cacheControl === "string")
        cacheControl = meta.cacheControl;
      if (typeof meta.contentType === "string" && !contentType)
        contentType = meta.contentType;
    } catch {
      // Not fatal — metadata is a nice-to-have; the payload is the point.
    }

    // Media part: headers end at the next blank line; its Content-Type wins
    // over the JSON's because it is what the writer put on the wire.
    const mediaHeaderEnd = payload.indexOf(HEADER_SEP, secondBoundary);
    if (mediaHeaderEnd === -1) return null;

    const mediaHeaders = payload
      .subarray(secondBoundary, mediaHeaderEnd)
      .toString("latin1");
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(mediaHeaders);
    if (ctMatch?.[1]) contentType = ctMatch[1].trim();

    const mediaStart = mediaHeaderEnd + HEADER_SEP.length;

    // Closing boundary: `\r\n--<uuid>--`, at the very end of the object.
    const closing = Buffer.concat([CRLF, boundary, Buffer.from("--")]);
    const closingAt = payload.lastIndexOf(closing);

    // Tolerate a missing finale (a truncated write) by keeping everything —
    // a partial payload is still better than an envelope, and the caller's
    // magic verification decides whether it is usable.
    const mediaEnd =
      closingAt !== -1 && closingAt >= mediaStart ? closingAt : payload.length;

    payload = payload.subarray(mediaStart, mediaEnd);
    layers++;
  }

  if (layers === 0) return null;
  return { payload, contentType, cacheControl, layers };
}
