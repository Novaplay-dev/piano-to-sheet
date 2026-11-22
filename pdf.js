// Builds an A4 PDF file from the sheet's lines (one SVG per line of music).
// Each page is drawn into a picture first, so no phone print dialog can cut a line.
const MM = 72 / 25.4, W = 210, H = 297, M = 12, DPI = 250; // ponytail: pages are pictures (not text); fine for printing
const px = (mm) => Math.round((mm / 25.4) * DPI);

// box: the part of the line's drawing to use [x, y, width, height]
function svgImage(svg, box) {
  const copy = svg.cloneNode(true);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('viewBox', box.join(' '));
  copy.setAttribute('width', box[2]); copy.setAttribute('height', box[3]);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  return new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => bad(new Error('could not draw the sheet'));
    img.src = url;
  });
}

async function deflate(bytes) {
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')); // zlib = PDF FlateDecode
  return new Uint8Array(await new Response(cs).arrayBuffer());
}

// svgs -> pages of whole lines -> PDF bytes
export async function sheetPdf(svgs) {
  const GAP = 4, BOTTOM = H - M - 8; // room for the page number
  // one scale for every line: wide enough for the widest (a crowded line can stick out a little)
  const right = (s) => { const b = s.getBBox(); return b.x + b.width; };
  const CW = Math.max(...svgs.map((s) => Math.max(s.viewBox.baseVal.width, right(s) + 1)));
  const items = svgs.map((svg) => {
    const vb = svg.viewBox.baseVal, bb = svg.getBBox();
    // a line without staff (the title) is centred on the page
    const title = bb.width < 0.6 * vb.width;
    const x = title ? bb.x + bb.width / 2 - CW / 2 : vb.x;
    return { svg, title, box: [x, vb.y, CW, vb.height], h: ((W - 2 * M) * vb.height) / CW };
  });
  const fill = (bottom) => {
    const pages = [];
    let page = null, y = 1e9;
    for (const it of items) {
      if (y + it.h > bottom && !(page && !page.length)) { page = []; pages.push(page); y = M; }
      page.push({ ...it, y }); y += it.h + GAP;
    }
    return pages;
  };
  // fewest pages, then the lines shared out evenly (no lonely last line)
  let pages = fill(BOTTOM);
  for (let b = M + (BOTTOM - M) / 2; b < BOTTOM; b += 2) { const p = fill(b); if (p.length === pages.length) { pages = p; break; } }
  // full pages: spread the lines evenly down to the bottom margin, like an engraved score
  pages.forEach((lines, i) => {
    if ((i === pages.length - 1 && pages.length > 1 && lines.length < pages[0].length) || lines.length < 2) return;
    const t = lines[0].title ? 1 : 0, gaps = lines.length - 1 - t; // the title stays with the first line
    if (gaps < 1) return;
    const last = lines[lines.length - 1], extra = Math.min(BOTTOM - (last.y + last.h), 30 * gaps);
    lines.forEach((l, k) => { l.y += (extra * Math.max(0, k - t)) / gaps; });
  });
  const cw = px(W), ch = px(H);
  const canvas = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const images = [];
  for (const lines of pages) {
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    for (const l of lines) g.drawImage(await svgImage(l.svg, l.box), px(M), px(l.y), px(W - 2 * M), px(l.h));
    if (pages.length > 1) {
      g.fillStyle = '#000'; g.font = `${px(3.5)}px Georgia, serif`; g.textAlign = 'center';
      g.fillText(`${images.length + 1} / ${pages.length}`, px(W / 2), px(H - M + 2));
    }
    const rgba = g.getImageData(0, 0, cw, ch).data, gray = new Uint8Array(cw * ch);
    for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4 + 1]; // sheet is black on white
    images.push(await deflate(gray));
  }
  // minimal PDF: catalog, pages, then per page: page, image, content stream
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body, stream) => {
    offs[n] = len;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.4\n%\xe2\xe3\n');
  const n = images.length, kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  const pw = (W * MM).toFixed(2), ph = (H * MM).toFixed(2);
  images.forEach((img, i) => {
    const p = 3 + i * 3, content = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`);
    obj(p + 1, `<< /Type /XObject /Subtype /Image /Width ${cw} /Height ${ch} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>`, img);
    obj(p + 2, `<< /Length ${content.length} >>`, content);
  });
  const xref = len, count = 3 + n * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let k = 1; k < count; k++) put(String(offs[k]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return { bytes: out, pages: n };
}
