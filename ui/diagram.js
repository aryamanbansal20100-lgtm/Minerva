/* ==========================================================================
   diagram.js — draws the diagrams in a note.

   No Mermaid, no D3, nothing to install. The AI returns a small JSON spec and
   this lays it out as SVG. Six shapes cover almost everything a lesson has:

     flow       a process with arrows
     cycle      a loop that comes back round
     mindmap    a centre with branches
     hierarchy  a tree
     timeline   dated points along a line
     compare    two columns against shared aspects
     graph      labelled axes with lines or curves

   Hand-laying-out six known shapes gives better-looking diagrams than a
   general charting library would, because each one can be tuned. Text wrapping
   is measured, not guessed, so labels never overflow their boxes.
   ========================================================================== */

const Diagram = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const CH = 6.9;              // approx px per character at 12.5px sans

  const el = (name, attrs = {}, text = '') => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== '') node.textContent = text;
    return node;
  };

  /* Greedy wrap on a character budget. Returns an array of lines. */
  function wrap(text, maxChars, maxLines = 4) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const candidate = line ? line + ' ' + w : w;
      if (candidate.length <= maxChars) { line = candidate; continue; }
      if (line) lines.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars - 1) + '…' : w;
      if (lines.length === maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    return lines.length ? lines : [''];
  }

  function textBlock(svg, lines, x, y, opts = {}) {
    const size = opts.size || 12.5;
    const lh = size * 1.25;
    const start = y - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => {
      svg.appendChild(el('text', {
        x, y: start + i * lh, 'text-anchor': opts.anchor || 'middle',
        'dominant-baseline': 'middle', 'font-size': size,
        'font-weight': opts.weight || 400,
        fill: opts.fill || 'var(--ink)',
        'font-family': opts.mono ? 'var(--mono)' : 'var(--sans)',
      }, ln));
    });
    return lines.length * lh;
  }

  function box(svg, x, y, w, h, opts = {}) {
    svg.appendChild(el('rect', {
      x, y, width: w, height: h, rx: opts.r === undefined ? 9 : opts.r,
      fill: opts.fill || 'var(--card)',
      stroke: opts.stroke || 'var(--line-strong)',
      'stroke-width': opts.sw || 1.2,
    }));
  }

  function arrow(svg, x1, y1, x2, y2, label) {
    svg.appendChild(el('line', {
      x1, y1, x2, y2, stroke: 'var(--ink-4)', 'stroke-width': 1.4,
      'marker-end': 'url(#minerva-arrow)',
    }));
    if (label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const w = String(label).length * CH + 10;
      svg.appendChild(el('rect', {
        x: mx - w / 2, y: my - 9, width: w, height: 18, rx: 5,
        fill: 'var(--card)', stroke: 'none',
      }));
      svg.appendChild(el('text', {
        x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 11, fill: 'var(--ink-3)', 'font-family': 'var(--sans)',
      }, String(label)));
    }
  }

  function frame(width, height) {
    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`, width, height,
      xmlns: NS, role: 'img',
    });
    const defs = el('defs');
    const marker = el('marker', {
      id: 'minerva-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    });
    marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--ink-4)' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    return svg;
  }

  /* ---------------------------------------------------------------- flow */
  function flow(spec) {
    const nodes = (spec.nodes || []).slice(0, 10);
    if (!nodes.length) return null;
    const W = 210, H0 = 46, GAP = 34;
    const laid = nodes.map(n => {
      const lines = wrap(n.label, 26, 3);
      return { ...n, lines, h: Math.max(H0, 20 + lines.length * 16) };
    });
    const total = laid.reduce((a, n) => a + n.h, 0) + GAP * (laid.length - 1);
    const svg = frame(W + 120, total + 20);
    let y = 10;
    const pos = {};
    for (const n of laid) {
      const x = 60;
      box(svg, x, y, W, n.h);
      textBlock(svg, n.lines, x + W / 2, y + n.h / 2, { weight: 500 });
      pos[n.id] = { x, y, w: W, h: n.h };
      y += n.h + GAP;
    }
    const edges = (spec.edges || []).length
      ? spec.edges
      : laid.slice(0, -1).map((n, i) => ({ from: n.id, to: laid[i + 1].id }));
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b || a === b) continue;
      arrow(svg, a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y - 4, e.label);
    }
    return svg;
  }

  /* --------------------------------------------------------------- cycle */
  function cycle(spec) {
    const steps = (spec.steps || []).slice(0, 8);
    if (steps.length < 2) return null;
    const R = 132, BW = 150, BH = 52, PAD = 96;
    const size = (R + PAD) * 2;
    const svg = frame(size, size);
    const cx = size / 2, cy = size / 2;
    const pts = steps.map((s, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps.length;
      return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, label: s, a };
    });
    pts.forEach((p, i) => {
      const next = pts[(i + 1) % pts.length];
      const mid = (p.a + (next.a > p.a ? next.a : next.a + Math.PI * 2)) / 2;
      const ax = cx + Math.cos(mid) * (R + 6), ay = cy + Math.sin(mid) * (R + 6);
      arrow(svg, p.x + Math.cos(p.a + 0.5) * 30, p.y + Math.sin(p.a + 0.5) * 30, ax, ay);
    });
    pts.forEach((p, i) => {
      const lines = wrap(p.label, 20, 3);
      const h = Math.max(BH, 18 + lines.length * 16);
      box(svg, p.x - BW / 2, p.y - h / 2, BW, h, { fill: 'var(--sunk)' });
      textBlock(svg, lines, p.x, p.y, { size: 12, weight: 500 });
      svg.appendChild(el('circle', { cx: p.x - BW / 2 + 2, cy: p.y - h / 2 + 2, r: 9,
        fill: 'var(--accent)' }));
      svg.appendChild(el('text', { x: p.x - BW / 2 + 2, y: p.y - h / 2 + 2,
        'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 10.5,
        fill: '#fff', 'font-weight': 700, 'font-family': 'var(--sans)' }, i + 1));
    });
    return svg;
  }

  /* ------------------------------------------------------------- mindmap */
  function mindmap(spec) {
    const branches = (spec.branches || []).slice(0, 7);
    if (!branches.length) return null;
    const colW = 250, rowH = 30;
    const left = branches.filter((_, i) => i % 2 === 0);
    const right = branches.filter((_, i) => i % 2 === 1);
    const rowsFor = b => 1 + Math.min((b.children || []).length, 6);
    const side = arr => arr.reduce((a, b) => a + rowsFor(b) + 0.6, 0);
    const height = Math.max(side(left), side(right), 4) * rowH + 60;
    const W = colW * 2 + 200;
    const svg = frame(W, height);
    const cx = W / 2, cy = height / 2;

    const centre = wrap(spec.centre || spec.title || 'Topic', 20, 2);
    const cw = 176, ch = Math.max(52, 22 + centre.length * 17);
    box(svg, cx - cw / 2, cy - ch / 2, cw, ch,
        { fill: 'var(--accent)', stroke: 'var(--accent)' });
    textBlock(svg, centre, cx, cy, { weight: 700, fill: '#fff', size: 13.5 });

    const draw = (arr, dir) => {
      let y = (height - side(arr) * rowH) / 2 + rowH / 2;
      for (const b of arr) {
        const bx = dir < 0 ? cx - cw / 2 - 70 : cx + cw / 2 + 70;
        const lines = wrap(b.label, 24, 2);
        const bw = 190, bh = Math.max(34, 14 + lines.length * 16);
        box(svg, dir < 0 ? bx - bw : bx, y - bh / 2, bw, bh, { fill: 'var(--sunk)' });
        textBlock(svg, lines, dir < 0 ? bx - bw / 2 : bx + bw / 2, y,
                  { size: 12.5, weight: 600 });
        svg.appendChild(el('path', {
          d: `M ${cx + dir * cw / 2} ${cy} C ${cx + dir * (cw / 2 + 40)} ${cy}, ` +
             `${bx - dir * 40} ${y}, ${bx} ${y}`,
          fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 1.4,
        }));
        let ky = y + bh / 2 + 6;
        for (const kid of (b.children || []).slice(0, 6)) {
          const kl = wrap(kid, 30, 1)[0];
          const kx = dir < 0 ? bx - 12 : bx + 12;
          svg.appendChild(el('text', {
            x: kx, y: ky + 8, 'text-anchor': dir < 0 ? 'end' : 'start',
            'dominant-baseline': 'middle', 'font-size': 11.5,
            fill: 'var(--ink-3)', 'font-family': 'var(--sans)',
          }, '· ' + kl));
          ky += 19;
        }
        y += (rowsFor(b) + 0.6) * rowH;
      }
    };
    draw(left, -1);
    draw(right, 1);
    return svg;
  }

  /* ----------------------------------------------------------- hierarchy */
  function hierarchy(spec) {
    const kids = (spec.children || []).slice(0, 6);
    if (!kids.length) return null;
    const colW = 210, W = Math.max(560, kids.length * colW);
    const deepest = Math.max(...kids.map(k => (k.children || []).length), 0);
    const H = 150 + deepest * 26;
    const svg = frame(W, H);
    const rootLines = wrap(spec.root || spec.title || 'Topic', 26, 2);
    const rw = 210, rh = Math.max(46, 20 + rootLines.length * 16);
    box(svg, W / 2 - rw / 2, 12, rw, rh, { fill: 'var(--accent)', stroke: 'var(--accent)' });
    textBlock(svg, rootLines, W / 2, 12 + rh / 2, { weight: 700, fill: '#fff' });

    kids.forEach((k, i) => {
      const cx = (i + 0.5) * (W / kids.length);
      const lines = wrap(k.label, 24, 2);
      const bw = Math.min(colW - 24, 186);
      const bh = Math.max(38, 16 + lines.length * 16);
      const by = 92;
      svg.appendChild(el('path', {
        d: `M ${W / 2} ${12 + rh} L ${W / 2} ${by - 22} L ${cx} ${by - 22} L ${cx} ${by}`,
        fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 1.4,
      }));
      box(svg, cx - bw / 2, by, bw, bh, { fill: 'var(--sunk)' });
      textBlock(svg, lines, cx, by + bh / 2, { size: 12.5, weight: 600 });
      let y = by + bh + 16;
      for (const child of (k.children || []).slice(0, 6)) {
        svg.appendChild(el('text', {
          x: cx, y, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': 11.5, fill: 'var(--ink-3)', 'font-family': 'var(--sans)',
        }, wrap(child, 28, 1)[0]));
        y += 22;
      }
    });
    return svg;
  }

  /* -------------------------------------------------------------- timeline */
  function timeline(spec) {
    const points = (spec.points || []).slice(0, 9);
    if (!points.length) return null;
    const rowH = 62, W = 640;
    const svg = frame(W, points.length * rowH + 34);
    const x = 132;
    svg.appendChild(el('line', {
      x1: x, y1: 22, x2: x, y2: points.length * rowH + 6,
      stroke: 'var(--line-strong)', 'stroke-width': 2,
    }));
    points.forEach((p, i) => {
      const y = 34 + i * rowH;
      svg.appendChild(el('circle', { cx: x, cy: y, r: 6, fill: 'var(--accent)' }));
      svg.appendChild(el('text', {
        x: x - 18, y, 'text-anchor': 'end', 'dominant-baseline': 'middle',
        'font-size': 12.5, 'font-weight': 700, fill: 'var(--ink-2)',
        'font-family': 'var(--mono)',
      }, wrap(p.when || '', 16, 1)[0]));
      textBlock(svg, wrap(p.what || '', 46, 3), x + 18, y,
                { anchor: 'start', size: 13 });
    });
    return svg;
  }

  /* --------------------------------------------------------------- compare */
  function compare(spec) {
    const rows = (spec.rows || []).slice(0, 9);
    if (!rows.length) return null;
    const cols = spec.columns || ['A', 'B'];
    const W = 700, aspectW = 150, colW = (W - aspectW) / 2;
    const heights = rows.map(r => Math.max(
      38, 16 + Math.max(wrap(r.left, 30, 4).length, wrap(r.right, 30, 4).length) * 16));
    const H = 46 + heights.reduce((a, b) => a + b, 0);
    const svg = frame(W, H);

    svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: 38,
      fill: 'var(--sunk)', rx: 8 }));
    textBlock(svg, [cols[0] || 'A'], aspectW + colW / 2, 19, { weight: 700, size: 13 });
    textBlock(svg, [cols[1] || 'B'], aspectW + colW * 1.5, 19, { weight: 700, size: 13 });

    let y = 38;
    rows.forEach((r, i) => {
      const h = heights[i];
      if (i) svg.appendChild(el('line', { x1: 0, y1: y, x2: W, y2: y,
        stroke: 'var(--line)', 'stroke-width': 1 }));
      textBlock(svg, wrap(r.aspect, 20, 3), 12, y + h / 2,
                { anchor: 'start', weight: 600, size: 12.5, fill: 'var(--ink-2)' });
      textBlock(svg, wrap(r.left, 30, 4), aspectW + colW / 2, y + h / 2, { size: 12.5 });
      textBlock(svg, wrap(r.right, 30, 4), aspectW + colW * 1.5, y + h / 2, { size: 12.5 });
      y += h;
    });
    svg.appendChild(el('line', { x1: aspectW, y1: 0, x2: aspectW, y2: H,
      stroke: 'var(--line)' }));
    svg.appendChild(el('line', { x1: aspectW + colW, y1: 0, x2: aspectW + colW, y2: H,
      stroke: 'var(--line)' }));
    return svg;
  }

  /* graph — labelled axes with one or more lines or curves.

     Added after a real Price Elasticity of Supply lesson produced excellent
     notes and zero diagrams. The reason was structural, not a model failure:
     the whole lesson is about the SHAPE of supply curves — vertical, horizontal,
     through the origin, cutting each axis — and not one of the six existing
     shapes can draw an axis. The model had nothing to emit.

     Economics, physics and maths are full of this: supply and demand, v-t
     graphs, enzyme rate curves, cost curves, gradients. Points are given in
     0-100 space in both directions so the model never has to think in pixels,
     and y is flipped here because SVG counts downwards. */
  function graph(spec) {
    const lines = (spec.lines || []).filter(l => (l.points || []).length >= 2);
    if (!lines.length) return null;

    const W = 400, H = 260;
    const L = 46, R = 18, T = 16, B = 40;      // margins for the axis labels
    const px = v => L + (Math.max(0, Math.min(100, Number(v) || 0)) / 100) * (W - L - R);
    const py = v => (H - B) - (Math.max(0, Math.min(100, Number(v) || 0)) / 100) * (H - T - B);

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%',
      style: `max-width:${W}px`, role: 'img',
      'aria-label': spec.title || 'graph',
    });

    // Axes.
    svg.appendChild(el('line', { x1: L, y1: T, x2: L, y2: H - B,
      stroke: 'var(--ink-3)', 'stroke-width': 1.25 }));
    svg.appendChild(el('line', { x1: L, y1: H - B, x2: W - R, y2: H - B,
      stroke: 'var(--ink-3)', 'stroke-width': 1.25 }));

    // Axis names. The y label reads bottom-to-top, as on paper.
    const yLab = el('text', {
      x: 14, y: (T + H - B) / 2, fill: 'var(--ink-2)', 'font-size': 12,
      'font-weight': 600, 'text-anchor': 'middle',
      transform: `rotate(-90 14 ${(T + H - B) / 2})`,
    }, spec.y || 'Price');
    svg.appendChild(yLab);
    svg.appendChild(el('text', {
      x: (L + W - R) / 2, y: H - 10, fill: 'var(--ink-2)', 'font-size': 12,
      'font-weight': 600, 'text-anchor': 'middle',
    }, spec.x || 'Quantity'));

    // Origin marker, because "passes through the origin" is often the point.
    svg.appendChild(el('text', { x: L - 8, y: H - B + 12, fill: 'var(--ink-4)',
      'font-size': 10.5, 'text-anchor': 'middle' }, '0'));

    const STROKE = ['var(--accent)', 'var(--calm)', 'var(--soon)', 'var(--late)'];
    lines.forEach((line, i) => {
      const pts = line.points.map(p => {
        const pair = Array.isArray(p) ? p : [p.x, p.y];
        return [px(pair[0]), py(pair[1])];
      });
      const d = pts.map((p, n) => `${n ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const colour = STROKE[i % STROKE.length];
      svg.appendChild(el('path', {
        d, fill: 'none', stroke: colour, 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-dasharray': line.dashed ? '5 4' : '',
      }));

      // Label the curve at its end, nudged inside the plot so it never clips.
      if (line.label) {
        const last = pts[pts.length - 1];
        const first = pts[0];
        // A vertical line is labelled at the top; anything else at its right end.
        const vertical = Math.abs(last[0] - first[0]) < 6;
        const lx = vertical ? last[0] : Math.min(last[0] + 6, W - R - 4);
        const ly = vertical ? Math.min(first[1], last[1]) - 6 : last[1] - 5;
        svg.appendChild(el('text', {
          x: lx, y: Math.max(T + 10, ly), fill: colour, 'font-size': 11.5,
          'font-weight': 600,
          'text-anchor': vertical ? 'middle' : (lx > W - R - 40 ? 'end' : 'start'),
        }, line.label));
      }
    });

    // An optional one-line reading of what the shape means.
    if (spec.note) {
      const note = el('text', { x: L, y: T + 2, fill: 'var(--ink-3)',
        'font-size': 11, 'text-anchor': 'start' }, spec.note);
      svg.appendChild(note);
    }
    return svg;
  }

  const KINDS = { flow, cycle, mindmap, hierarchy, timeline, compare, graph };

  /** Render a spec into a wrapper element, or null if it cannot be drawn. */
  function render(spec) {
    if (!spec || typeof spec !== 'object') return null;
    const fn = KINDS[String(spec.kind || '').toLowerCase()];
    let svg = null;
    try { svg = fn ? fn(spec) : null; } catch { svg = null; }
    if (!svg) return null;
    const wrapEl = document.createElement('div');
    wrapEl.className = 'diagram-wrap';
    wrapEl.appendChild(svg);
    if (spec.title) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = spec.title;
      wrapEl.appendChild(cap);
    }
    return wrapEl;
  }

  return { render, kinds: Object.keys(KINDS) };
})();
