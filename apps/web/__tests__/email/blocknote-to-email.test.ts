/**
 * BlockNote → Email HTML Converter Tests — REAL source
 * (packages/email/src/blocknote-to-email.ts via `@usemoney/email`).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented the ENTIRE
 * converter inline — `escapeHtml`, `escapeAttr`, `renderInlineContent`,
 * `blockToHtml`, `renderChildren`, `renderTable`, `renderYouTubeEmbed`,
 * `groupListItems`, `blocknoteToEmailHtml` — and asserted those copies.
 *
 * Only `blocknoteToEmailHtml` is a public export; the helpers are module-
 * private. Rather than add dead exports, every case is re-expressed through the
 * REAL public `blocknoteToEmailHtml` (wrapping a single block in a one-element
 * document where the old test poked a private helper). This exercises the REAL
 * escape/inline/block/list/table/youtube logic transitively — the production
 * code path content emails actually render through.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}
interface TextContent {
  type: "text";
  text: string;
  styles: InlineStyle;
}
interface LinkContent {
  type: "link";
  href: string;
  content: TextContent[];
}
type InlineContent = TextContent | LinkContent;
interface Block {
  type: string;
  props: Record<string, unknown>;
  content?: InlineContent[] | string;
  children?: Block[];
}

let blocknoteToEmailHtml: (content: string | Block[]) => string;

/** Render a single block by wrapping it in a one-element document. */
function render(block: Block): string {
  return blocknoteToEmailHtml([block]);
}
/** Render a free inline run by wrapping it in a paragraph. */
function renderInline(content: InlineContent[]): string {
  return blocknoteToEmailHtml([{ type: "paragraph", props: {}, content }]);
}

before(async () => {
  const mod = await import("@usemoney/email");
  blocknoteToEmailHtml =
    mod.blocknoteToEmailHtml as typeof blocknoteToEmailHtml;
});

describe("HTML escaping (via real converter)", () => {
  it("should escape ampersands and angle brackets in text", () => {
    const html = renderInline([
      { type: "text", text: "A & B <C>", styles: {} },
    ]);
    assert.ok(html.includes("A &amp; B &lt;C&gt;"));
  });

  it("should escape double quotes in text", () => {
    const html = renderInline([{ type: "text", text: 'say "hi"', styles: {} }]);
    assert.ok(html.includes("say &quot;hi&quot;"));
  });

  it("should escape single quotes in attribute context (href)", () => {
    const html = renderInline([
      {
        type: "link",
        href: "https://x.test/?q='a'",
        content: [{ type: "text", text: "l", styles: {} }],
      },
    ]);
    assert.ok(html.includes("&#39;"));
  });
});

describe("inline content (via real converter)", () => {
  it("renders plain text", () => {
    assert.ok(
      renderInline([
        { type: "text", text: "Hello world", styles: {} },
      ]).includes("Hello world")
    );
  });

  it("renders bold / italic / underline / strikethrough / code", () => {
    assert.ok(
      renderInline([
        { type: "text", text: "b", styles: { bold: true } },
      ]).includes("<strong>b</strong>")
    );
    assert.ok(
      renderInline([
        { type: "text", text: "i", styles: { italic: true } },
      ]).includes("<em>i</em>")
    );
    assert.ok(
      renderInline([
        { type: "text", text: "u", styles: { underline: true } },
      ]).includes("text-decoration:underline")
    );
    assert.ok(
      renderInline([
        { type: "text", text: "s", styles: { strikethrough: true } },
      ]).includes("text-decoration:line-through")
    );
    const code = renderInline([
      { type: "text", text: "const x = 1", styles: { code: true } },
    ]);
    assert.ok(code.includes("<code") && code.includes("const x = 1"));
  });

  it("nests multiple styles", () => {
    const html = renderInline([
      { type: "text", text: "bi", styles: { bold: true, italic: true } },
    ]);
    assert.ok(html.includes("<strong>") && html.includes("<em>"));
  });

  it("renders links (with target=_blank) including styled inner text", () => {
    const html = renderInline([
      {
        type: "link",
        href: "https://example.com",
        content: [{ type: "text", text: "bold link", styles: { bold: true } }],
      },
    ]);
    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes("<strong>bold link</strong>"));
  });

  it("concatenates multiple inline items", () => {
    const html = renderInline([
      { type: "text", text: "Hello ", styles: {} },
      { type: "text", text: "world", styles: { bold: true } },
    ]);
    assert.ok(html.includes("Hello <strong>world</strong>"));
  });

  it("escapes HTML in text content (XSS-safe)", () => {
    const html = renderInline([
      { type: "text", text: "<script>alert('xss')</script>", styles: {} },
    ]);
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
  });
});

describe("paragraph (via real converter)", () => {
  it("renders a left-aligned paragraph", () => {
    const html = render({
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Hello", styles: {} }],
    });
    assert.ok(html.includes("<p") && html.includes("Hello"));
    assert.ok(html.includes("text-align:left"));
  });

  it("renders a centered paragraph", () => {
    assert.ok(
      render({
        type: "paragraph",
        props: { textAlignment: "center" },
        content: [{ type: "text", text: "C", styles: {} }],
      }).includes("text-align:center")
    );
  });

  it("renders an empty paragraph as <br />", () => {
    assert.strictEqual(
      render({ type: "paragraph", props: {}, content: [] }),
      "<br />"
    );
  });

  it("detects YouTube embed markers in paragraph text", () => {
    const html = render({
      type: "paragraph",
      props: {},
      content: [
        {
          type: "text",
          text: "[YouTube: https://www.youtube.com/watch?v=dQw4w9WgXcQ]",
          styles: {},
        },
      ],
    });
    assert.ok(html.includes("dQw4w9WgXcQ"));
    assert.ok(html.includes("youtube.com"));
  });
});

describe("heading (via real converter)", () => {
  it("renders h1/h2/h3 with the right sizes", () => {
    const h1 = render({
      type: "heading",
      props: { level: 1 },
      content: [{ type: "text", text: "Title", styles: {} }],
    });
    assert.ok(
      h1.includes("<h1") && h1.includes("28px") && h1.includes("Title")
    );
    assert.ok(
      render({
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "x", styles: {} }],
      }).includes("24px")
    );
    assert.ok(
      render({
        type: "heading",
        props: { level: 3 },
        content: [{ type: "text", text: "x", styles: {} }],
      }).includes("20px")
    );
  });

  it("defaults to h1 without level", () => {
    assert.ok(
      render({
        type: "heading",
        props: {},
        content: [{ type: "text", text: "No level", styles: {} }],
      }).includes("<h1")
    );
  });
});

describe("checkListItem (via real converter)", () => {
  it("renders unchecked and checked boxes", () => {
    assert.ok(
      render({
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "Todo", styles: {} }],
      }).includes("&#9744;")
    );
    assert.ok(
      render({
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "Done", styles: {} }],
      }).includes("&#9745;")
    );
  });
});

describe("image (via real converter)", () => {
  it("renders an image with src + caption", () => {
    const html = render({
      type: "image",
      props: { url: "https://example.com/img.jpg", caption: "A photo" },
    });
    assert.ok(html.includes("<img"));
    assert.ok(html.includes("https://example.com/img.jpg"));
    assert.ok(html.includes("A photo"));
  });

  it("returns empty for missing src", () => {
    assert.strictEqual(render({ type: "image", props: {} }), "");
  });

  it("uses custom width and defaults to 600", () => {
    assert.ok(
      render({
        type: "image",
        props: { url: "https://example.com/img.jpg", width: 400 },
      }).includes('width="400"')
    );
    assert.ok(
      render({
        type: "image",
        props: { url: "https://example.com/img.jpg" },
      }).includes('width="600"')
    );
  });
});

describe("codeBlock (via real converter)", () => {
  it("renders inline-array and string content, escaping HTML", () => {
    assert.ok(
      render({
        type: "codeBlock",
        props: {},
        content: [{ type: "text", text: "const x = 1;", styles: {} }],
      }).includes("const x = 1;")
    );
    assert.ok(
      render({
        type: "codeBlock",
        props: {},
        content: "function foo() { return 42; }",
      }).includes("function foo()")
    );
    assert.ok(
      render({
        type: "codeBlock",
        props: {},
        content: "<div>hello</div>",
      }).includes("&lt;div&gt;")
    );
  });
});

describe("table (via real converter)", () => {
  it("renders rows and cells", () => {
    const html = render({
      type: "table",
      props: {},
      content: [
        {
          cells: [
            [{ type: "text" as const, text: "A", styles: {} }],
            [{ type: "text" as const, text: "B", styles: {} }],
          ],
        },
        {
          cells: [
            [{ type: "text" as const, text: "C", styles: {} }],
            [{ type: "text" as const, text: "D", styles: {} }],
          ],
        },
      ] as unknown as InlineContent[],
    });
    assert.ok(html.includes("<table") && html.includes("<td"));
    assert.ok(html.includes("A") && html.includes("D"));
  });

  it("returns empty for no content", () => {
    assert.strictEqual(render({ type: "table", props: {} }), "");
  });
});

describe("youtube block (via real converter)", () => {
  it("renders embed from watch / youtu.be / shorts URLs", () => {
    assert.ok(
      render({
        type: "youtube",
        props: { url: "https://www.youtube.com/watch?v=abc123" },
      }).includes("abc123")
    );
    assert.ok(
      render({
        type: "youtube",
        props: { url: "https://youtu.be/abc123" },
      }).includes("abc123")
    );
    assert.ok(
      render({
        type: "youtube",
        props: { url: "https://youtube.com/shorts/abc123" },
      }).includes("abc123")
    );
  });

  it("returns empty for missing / non-YouTube URL", () => {
    assert.strictEqual(render({ type: "youtube", props: {} }), "");
    assert.strictEqual(
      render({
        type: "youtube",
        props: { url: "https://example.com/not-youtube" },
      }),
      ""
    );
  });
});

describe("unknown block type (via real converter)", () => {
  it("renders content in a div", () => {
    const html = render({
      type: "custom-widget",
      props: {},
      content: [{ type: "text", text: "Custom content", styles: {} }],
    });
    assert.ok(html.includes("<div") && html.includes("Custom content"));
  });

  it("returns empty for unknown type with no content", () => {
    assert.strictEqual(render({ type: "unknown", props: {} }), "");
  });
});

describe("list grouping (via real converter)", () => {
  it("wraps consecutive bullet items in a single <ul>", () => {
    const html = blocknoteToEmailHtml([
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "A", styles: {} }],
      },
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "B", styles: {} }],
      },
    ]);
    assert.ok(html.includes("A") && html.includes("B"));
    assert.strictEqual((html.match(/<ul/g) || []).length, 1);
  });

  it("wraps consecutive numbered items in a single <ol>", () => {
    const html = blocknoteToEmailHtml([
      {
        type: "numberedListItem",
        props: {},
        content: [{ type: "text", text: "1", styles: {} }],
      },
      {
        type: "numberedListItem",
        props: {},
        content: [{ type: "text", text: "2", styles: {} }],
      },
    ]);
    assert.strictEqual((html.match(/<ol/g) || []).length, 1);
  });

  it("renders nested children under a list item", () => {
    const html = blocknoteToEmailHtml([
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "Parent", styles: {} }],
        children: [
          {
            type: "bulletListItem",
            props: {},
            content: [{ type: "text", text: "Child", styles: {} }],
          },
        ],
      },
    ]);
    assert.ok(html.includes("Parent") && html.includes("Child"));
    assert.ok(html.includes("<ul"));
  });

  it("separates different list types and mixes with paragraphs", () => {
    const html = blocknoteToEmailHtml([
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Intro", styles: {} }],
      },
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "A", styles: {} }],
      },
      {
        type: "numberedListItem",
        props: {},
        content: [{ type: "text", text: "1", styles: {} }],
      },
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "End", styles: {} }],
      },
    ]);
    assert.ok(html.includes("Intro") && html.includes("End"));
    assert.ok(html.includes("<ul") && html.includes("<ol"));
  });
});

describe("blocknoteToEmailHtml (public API)", () => {
  it("parses a JSON string of blocks", () => {
    const json = JSON.stringify([
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Test", styles: {} }],
      },
    ]);
    assert.ok(blocknoteToEmailHtml(json).includes("Test"));
  });

  it("accepts a Block array directly", () => {
    assert.ok(
      blocknoteToEmailHtml([
        {
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Direct", styles: {} }],
        },
      ]).includes("Direct")
    );
  });

  it("treats invalid JSON as plain text (escaped, wrapped in <p>)", () => {
    const html = blocknoteToEmailHtml("This is just plain text, not JSON");
    assert.ok(html.includes("This is just plain text"));
    assert.ok(html.includes("<p"));
  });

  it("escapes XSS in the plain-text fallback", () => {
    const html = blocknoteToEmailHtml('<script>alert("xss")</script>');
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
  });

  it("returns empty for empty array, empty JSON array, and non-array JSON", () => {
    assert.strictEqual(blocknoteToEmailHtml([]), "");
    assert.strictEqual(blocknoteToEmailHtml("[]"), "");
    assert.strictEqual(blocknoteToEmailHtml('{"type":"not-an-array"}'), "");
  });

  it("converts a full mixed document", () => {
    const html = blocknoteToEmailHtml([
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Title", styles: {} }],
      },
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Intro paragraph.", styles: {} }],
      },
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "Point A", styles: {} }],
      },
      {
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "Point B", styles: {} }],
      },
      {
        type: "image",
        props: { url: "https://example.com/photo.jpg", caption: "Photo" },
      },
    ]);
    assert.ok(html.includes("<h1") && html.includes("Title"));
    assert.ok(html.includes("Intro paragraph"));
    assert.ok(html.includes("<ul") && html.includes("Point A"));
    assert.ok(html.includes("<img") && html.includes("Photo"));
  });
});
