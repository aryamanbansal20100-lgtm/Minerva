/* ==========================================================================
   mathText.ts — LaTeX, made readable.

   Models write maths in LaTeX whatever you ask for; it is what textbooks and
   training data are full of. Printed raw it reads as computer code:

     "$\% \Delta Q_s$ / $\% \Delta P$"   instead of   "%ΔQs / %ΔP"
     "$P_{old}$"                          instead of   "Pold"

   A real Economics note came back accurate and unreadable for exactly that
   reason. There is no maths engine here and there does not need to be — school
   notation is symbols plus sub/superscripts, and that is plain markup.

   This is a straight port of the working implementation. The ORDER OF THE
   STEPS IS LOAD-BEARING: several of them only work because of what ran
   immediately before. In particular `esc()` is the security boundary —
   everything before it is plain text, everything after it emits tags.

   Two shapes come out of this file:

     mathText / inlineMd  the original functions, returning ALREADY-ESCAPED
                          HTML. Kept byte-identical so behaviour can be
                          compared against the old build.
     inlineNodes / mathNodes
                          the same output parsed back into a small node tree,
                          so React renders real elements and this app never
                          needs dangerouslySetInnerHTML. The HTML the parser
                          reads is the HTML this file just produced — a closed
                          set of five tags over escaped text — so the round
                          trip cannot smuggle markup in from a note.
   ========================================================================== */

/** Greek letters. Case-sensitive on purpose: \Delta is Δ, \delta is δ. */
export const GREEK: Record<string, string> = {
  Delta: "Δ", delta: "δ", alpha: "α", beta: "β", gamma: "γ", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", omega: "ω",
  Omega: "Ω", Sigma: "Σ", epsilon: "ε", phi: "φ", tau: "τ",
};

/** Operators and relations. These do fall back to a lower-case lookup. */
export const OPS: Record<string, string> = {
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", leq: "≤", le: "≤",
  geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡",
  infty: "∞", rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒",
  propto: "∝", sum: "Σ", int: "∫", sqrt: "√", therefore: "∴", because: "∵",
  ldots: "…", dots: "…", percent: "%",
};

const ESCAPED: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
};

/** Escape the four characters that could otherwise start markup. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ESCAPED[c]);
}

/**
 * LaTeX in, readable escaped HTML out.
 *
 * Returns markup, not text: callers must NOT escape the result again, or the
 * reader sees a literal `<sub>` in the middle of their notes.
 */
export function mathText(raw: unknown): string {
  let s = String(raw ?? "");

  /* 1. Strip the delimiters; display and inline maths are handled the same. */
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, "$1").replace(/\$([^$]+?)\$/g, "$1");
  s = s.replace(/\\[()[\]]/g, "");

  /* 2. \frac{a}{b} -> (a)/(b), innermost first so nesting resolves. Four
        passes is deeper than any school formula goes; it stops early when a
        pass changes nothing. \d?frac also catches \dfrac. */
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
    if (next === s) break;
    s = next;
  }

  /* 3. The other braced commands. */
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1");

  /* 4. \% and \{ are escaped literals, not commands — before the lookup. */
  s = s.replace(/\\([%&_#{}$])/g, "$1");

  /* 5. Command lookup. An unknown command loses only its backslash, so a
        formula with one odd macro in it still reads. */
  s = s.replace(/\\([A-Za-z]+)/g, (m, name: string) =>
    GREEK[name] || OPS[name] || OPS[name.toLowerCase()] || m.slice(1));

  /* 6. Escape here. Everything past this line emits real tags. */
  s = esc(s);

  /* 7. Sub/superscripts: X_{old} and X_old, X^{2} and X^2. The asymmetric
        limits (18 braced, 6 bare subscript with a word boundary, 4 bare
        superscript without one) are what stop "x_and then a whole sentence"
        from becoming a subscript. */
  s = s.replace(/_\{([^{}]{1,18})\}/g, (_m, t: string) => "<sub>" + t + "</sub>")
    .replace(/\^\{([^{}]{1,18})\}/g, (_m, t: string) => "<sup>" + t + "</sup>")
    .replace(/_([A-Za-z0-9]{1,6})\b/g, "<sub>$1</sub>")
    .replace(/\^([A-Za-z0-9]{1,4})/g, "<sup>$1</sup>");

  /* 8. Any leftover braces were LaTeX grouping, not content. */
  s = s.replace(/[{}]/g, "");

  /* 9. LaTeX puts a space after every command, so "\% \Delta Q_s" arrives as
        "% Δ Q" — close those up, the way it would be written on paper. Both
        U+0394 (Δ) and U+2206 (∆) count. */
  s = s.replace(/([%Δ∆])\s+(?=[ΔA-Za-z(])/g, "$1")
    .replace(/\s+(?=<sub>|<sup>)/g, "");
  return s;
}

/**
 * Inline markdown inside a note item, on top of the maths.
 *
 * The model writes **bold**, *italic* and `code` inside list items because
 * that is how anyone writes notes. Escaping and dumping them raw is why a
 * genuinely good note once read as "How** the comic communicates".
 *
 * Order matters as much as it does in mathText:
 *   - bold before italic, so **x** is not eaten by the single-star rule;
 *   - the italic rule needs a boundary before the opener and after the closer,
 *     which is what stops "2 * 3 * 4" italicising;
 *   - the stray-marker sweep runs after `code`, so backticked asterisks are
 *     already protected;
 *   - __bold__ runs last and works only because mathText left it alone: "_"
 *     is a word character, so "_bold_" fails the \b in the bare-subscript
 *     rule. Single-underscore italics are therefore NOT supported, which is
 *     deliberate: school notes contain P_old far more often than _emphasis_.
 */
export function inlineMd(raw: unknown): string {
  return mathText(raw)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*/g, "")
    .replace(/(^|\s)__(.+?)__(?=\s|$)/g, "$1<b>$2</b>");
}

/* -------------------------------------------------------------------------
   The node tree.

   mathText guarantees escaped output, so `dangerouslySetInnerHTML` would be
   safe — but only for as long as nobody reorders step 6, and that is a
   footgun to leave lying in a codebase. Parsing the five tags back out costs
   one small state machine and removes the sharp edge entirely.
   ------------------------------------------------------------------------- */

export type InlineTagName = "sub" | "sup" | "b" | "i" | "code";

export interface InlineTag {
  tag: InlineTagName;
  children: InlineNode[];
}

/** A run of text, or one of the five tags, nested. */
export type InlineNode = string | InlineTag;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };

/** Undo `esc`. One pass, so "&amp;lt;" comes back as "&lt;" and stops there. */
function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot);/g, (_m, name: string) => ENTITY[name]);
}

const TAG = /<(\/?)(sub|sup|b|i|code)>/g;

/**
 * Parse the closed tag set this file emits back into a tree.
 *
 * Only ever fed output from mathText/inlineMd. Anything that is not one of the
 * five tags arrived as escaped text and stays text, which is what makes the
 * round trip safe rather than merely convenient.
 */
export function parseInline(html: string): InlineNode[] {
  const root: InlineNode[] = [];
  const open: InlineTag[] = [];
  const into = (): InlineNode[] =>
    open.length ? open[open.length - 1].children : root;

  const text = (piece: string) => {
    if (piece) into().push(unesc(piece));
  };

  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((match = TAG.exec(html)) !== null) {
    text(html.slice(cursor, match.index));
    cursor = TAG.lastIndex;
    const name = match[2] as InlineTagName;
    if (!match[1]) {
      const node: InlineTag = { tag: name, children: [] };
      into().push(node);
      open.push(node);
      continue;
    }
    /* Close the nearest matching opener, dropping anything still open inside
       it. A closer with no opener is dropped rather than shown. */
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].tag === name) {
        open.length = i;
        break;
      }
    }
  }
  text(html.slice(cursor));
  return root;
}

/** Maths and inline markdown, as a node tree. */
export function inlineNodes(raw: unknown): InlineNode[] {
  return parseInline(inlineMd(raw));
}

/** Maths only — no markdown. Used for formula lines, which are LaTeX by nature. */
export function mathNodes(raw: unknown): InlineNode[] {
  return parseInline(mathText(raw));
}

/** Flatten a tree back to plain text, for aria-labels and titles. */
export function nodeText(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    out += typeof node === "string" ? node : nodeText(node.children);
  }
  return out;
}

/** Plain-text maths: readable symbols, no markup at all. */
export function mathPlain(raw: unknown): string {
  return nodeText(mathNodes(raw));
}
