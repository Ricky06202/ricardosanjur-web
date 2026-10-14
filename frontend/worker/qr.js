/* ------------------------------------------------------------------
   RSQR - generador de codigos QR propio (sin dependencias externas).
   Modo byte, versiones 1-40, niveles L/M/Q/H. rsanjur.com
   ------------------------------------------------------------------ */
(function (root) {
  'use strict';

  var CODEWORDS = [
    0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991,
    1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532,
    3706
  ];
  var EC_BLOCKS = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4,
    2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8,
    4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18,
    6, 10, 17, 16, 6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25,
    8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35,
    12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48,
    16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63,
    20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81
  ];
  var EC_CW = [
    7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88,
    36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192, 72, 130, 192, 224,
    80, 150, 224, 264, 96, 176, 260, 308, 104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432,
    144, 280, 408, 480, 168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700,
    224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588, 870, 1050,
    336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440,
    480, 868, 1290, 1530, 510, 924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890,
    600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430
  ];
  var ECL = {
    L: { idx: 0, bit: 1 },
    M: { idx: 1, bit: 0 },
    Q: { idx: 2, bit: 3 },
    H: { idx: 3, bit: 2 }
  };

  /* ---------------- campo de Galois 2^8 ---------------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  }());
  function gmul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }

  function rsGen(n) {
    var poly = [1], i, j;
    for (i = 0; i < n; i++) {
      var next = new Array(poly.length + 1);
      for (j = 0; j < next.length; j++) next[j] = 0;
      for (j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGen(ecLen);
    var res = new Array(ecLen), i, j;
    for (i = 0; i < ecLen; i++) res[i] = 0;
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) for (j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* ---------------- utilidades ---------------- */
  function bchDigit(v) { var n = 0; while (v !== 0) { n++; v >>>= 1; } return n; }

  function formatBits(eclBit, mask) {
    var G15 = 0x537;
    var data = (eclBit << 3) | mask;
    var d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
    return ((data << 10) | d) ^ 0x5412;
  }

  function versionBits(version) {
    var G18 = 0x1f25;
    var d = version << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
    return (version << 12) | d;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return out;
  }

  function alignCoords(version) {
    if (version === 1) return [];
    var posCount = Math.floor(version / 7) + 2;
    var size = version * 4 + 17;
    var intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
    var positions = [size - 7], i;
    for (i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
    positions.push(6);
    return positions.reverse();
  }

  function chooseVersion(byteLen, eclIdx) {
    for (var v = 1; v <= 40; v++) {
      var ccBits = v <= 9 ? 8 : 16;
      var dataCap = CODEWORDS[v] - EC_CW[(v - 1) * 4 + eclIdx];
      if (4 + ccBits + byteLen * 8 <= dataCap * 8) return v;
    }
    throw new Error('RSQR: datos demasiado grandes');
  }

  /* ---------------- datos -> codewords ---------------- */
  function buildCodewords(bytes, version, eclIdx) {
    var dataCap = CODEWORDS[version] - EC_CW[(version - 1) * 4 + eclIdx];
    var maxBits = dataCap * 8;
    var bits = [], i, k;
    function push(val, len) { for (var b = len - 1; b >= 0; b--) bits.push((val >>> b) & 1); }
    push(4, 4);                          // modo byte
    push(bytes.length, version <= 9 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);
    for (i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var cw = [];
    for (i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
      cw.push(byte);
    }
    var pads = [0xec, 0x11], p = 0;
    while (cw.length < dataCap) { cw.push(pads[p++ % 2]); }
    return cw;
  }

  function interleave(dataCw, version, eclIdx) {
    var ecTotal = EC_CW[(version - 1) * 4 + eclIdx];
    var blocks = EC_BLOCKS[(version - 1) * 4 + eclIdx];
    var ecPer = ecTotal / blocks;
    var numShort = blocks - (dataCw.length % blocks);
    var shortLen = Math.floor(dataCw.length / blocks);
    var dataBlocks = [], ecBlocks = [], pos = 0, b, i;
    for (b = 0; b < blocks; b++) {
      var len = shortLen + (b < numShort ? 0 : 1);
      var d = dataCw.slice(pos, pos + len);
      pos += len;
      dataBlocks.push(d);
      ecBlocks.push(rsEncode(d, ecPer));
    }
    var out = [];
    for (i = 0; i <= shortLen; i++)
      for (b = 0; b < blocks; b++) if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    for (i = 0; i < ecPer; i++)
      for (b = 0; b < blocks; b++) out.push(ecBlocks[b][i]);
    return out;
  }

  /* ---------------- matriz ---------------- */
  function maskFn(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function buildBase(version) {
    var size = version * 4 + 17, r, c, i, j;
    var mat = [], res = [];
    for (r = 0; r < size; r++) {
      mat.push(new Array(size));
      res.push(new Array(size));
      for (c = 0; c < size; c++) { mat[r][c] = 0; res[r][c] = false; }
    }
    function set(r, c, v) { mat[r][c] = v ? 1 : 0; res[r][c] = true; }

    // patrones de posicion (finder) + separadores
    var corners = [[0, 0], [0, size - 7], [size - 7, 0]];
    for (i = 0; i < 3; i++) {
      for (r = -1; r <= 7; r++) {
        for (c = -1; c <= 7; c++) {
          var rr = corners[i][0] + r, cc = corners[i][1] + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var inside = (r >= 0 && r <= 6 && c >= 0 && c <= 6);
          var dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(rr, cc, dark);
        }
      }
    }

    // patrones de sincronizacion (timing)
    for (i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // patrones de alineacion
    var coords = alignCoords(version);
    if (coords.length) {
      for (i = 0; i < coords.length; i++) {
        for (j = 0; j < coords.length; j++) {
          var ar = coords[i], ac = coords[j];
          if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
          for (r = -2; r <= 2; r++) {
            for (c = -2; c <= 2; c++) {
              var edge = (r === -2 || r === 2 || c === -2 || c === 2);
              set(ar + r, ac + c, edge || (r === 0 && c === 0));
            }
          }
        }
      }
    }

    // modulo oscuro fijo
    set(size - 8, 8, true);

    // reservar zona de formato
    for (i = 0; i < 15; i++) {
      if (i < 6) set(i, 8, false);
      else if (i < 8) set(i + 1, 8, false);
      else set(size - 15 + i, 8, false);
      if (i < 8) set(8, size - i - 1, false);
      else if (i < 9) set(8, 15 - i, false);
      else set(8, 15 - i - 1, false);
    }

    // reservar zona de version (v >= 7)
    if (version >= 7) {
      for (i = 0; i < 18; i++) {
        var vr = Math.floor(i / 3), vc = (i % 3) + size - 11;
        set(vr, vc, false);
        set(vc, vr, false);
      }
    }

    return { size: size, mat: mat, res: res };
  }

  function placeData(base, cw) {
    var size = base.size, mat = base.mat, res = base.res;
    var totalBits = cw.length * 8, bitIdx = 0, inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var c = 0; c < 2; c++) {
          var rr = row, cc = col - c;
          if (!res[rr][cc]) {
            var dark = 0;
            if (byteIndex < cw.length) dark = (cw[byteIndex] >>> bitIndex) & 1;
            mat[rr][cc] = dark;
            bitIdx++;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
    return base;
  }

  function cloneMat(base) {
    var mat = [], r;
    for (r = 0; r < base.size; r++) mat.push(base.mat[r].slice());
    return mat;
  }

  function applyMask(base, mat, m) {
    for (var r = 0; r < base.size; r++)
      for (var c = 0; c < base.size; c++)
        if (!base.res[r][c] && maskFn(m, r, c)) mat[r][c] ^= 1;
  }

  function writeFormat(base, mat, eclBit, mask) {
    var size = base.size;
    var bits = formatBits(eclBit, mask), i;
    for (i = 0; i < 15; i++) {
      var mod = ((bits >> i) & 1) === 1 ? 1 : 0;
      if (i < 6) mat[i][8] = mod;
      else if (i < 8) mat[i + 1][8] = mod;
      else mat[size - 15 + i][8] = mod;
      if (i < 8) mat[8][size - i - 1] = mod;
      else if (i < 9) mat[8][15 - i] = mod;
      else mat[8][15 - i - 1] = mod;
    }
    mat[size - 8][8] = 1;
  }

  function writeVersion(base, mat, version) {
    if (version < 7) return;
    var size = base.size, bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var mod = ((bits >> i) & 1) === 1 ? 1 : 0;
      var r = Math.floor(i / 3), c = (i % 3) + size - 11;
      mat[r][c] = mod;
      mat[c][r] = mod;
    }
  }

  function penalty(mat, size) {
    var points = 0, r, c, i;

    // N1 - rachas de 5 o mas
    for (r = 0; r < size; r++) {
      var runR = 1, runC = 1;
      for (c = 1; c < size; c++) {
        runR = mat[r][c] === mat[r][c - 1] ? runR + 1 : 1;
        if (runR === 5) points += 3; else if (runR > 5) points += 1;
        runC = mat[c][r] === mat[c - 1][r] ? runC + 1 : 1;
        if (runC === 5) points += 3; else if (runC > 5) points += 1;
      }
    }

    // N2 - bloques 2x2
    for (r = 0; r < size - 1; r++)
      for (c = 0; c < size - 1; c++) {
        var s = mat[r][c] + mat[r][c + 1] + mat[r + 1][c] + mat[r + 1][c + 1];
        if (s === 4 || s === 0) points += 3;
      }

    // N3 - patron 1:1:3:1:1 con area clara
    for (r = 0; r < size; r++) {
      var bitsCol = 0, bitsRow = 0;
      for (c = 0; c < size; c++) {
        bitsCol = ((bitsCol << 1) & 0x7ff) | mat[r][c];
        if (c >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
        bitsRow = ((bitsRow << 1) & 0x7ff) | mat[c][r];
        if (c >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
      }
    }

    // N4 - proporcion de modulos oscuros
    var dark = 0, total = size * size;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += mat[r][c];
    points += Math.abs(Math.ceil((dark * 100 / total) / 5) - 10) * 10;

    return points;
  }

  /* ---------------- API ---------------- */
  function makeMatrix(text, opts) {
    opts = opts || {};
    var ecl = ECL[opts.ecl || 'M'] || ECL.M;
    var bytes = utf8(String(text));
    var version = opts.version || chooseVersion(bytes.length, ecl.idx);
    if (version > 40) throw new Error('RSQR: version invalida');
    var dataCw = buildCodewords(bytes, version, ecl.idx);
    var cw = interleave(dataCw, version, ecl.idx);
    var base = buildBase(version);
    placeData(base, cw);
    writeVersion(base, base.mat, version);

    var forced = typeof opts.mask === 'number' ? opts.mask : null;
    var bestMat = null, bestMask = 0, bestScore = Infinity;
    var candidates = forced === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forced];
    var i;
    for (i = 0; i < candidates.length; i++) {
      var m = candidates[i];
      var mat = cloneMat(base);
      applyMask(base, mat, m);
      writeFormat(base, mat, ecl.bit, m);
      var score = penalty(mat, base.size);
      if (score < bestScore) { bestScore = score; bestMat = mat; bestMask = m; }
    }
    return { size: base.size, version: version, mask: bestMask, modules: bestMat };
  }

  function svg(text, opts) {
    opts = opts || {};
    var qr = makeMatrix(text, opts);
    var size = qr.size;
    var margin = opts.margin === undefined ? 4 : opts.margin;
    var px = opts.size || 240;
    var dim = size + margin * 2;
    var parts = [], r, c;
    for (r = 0; r < size; r++)
      for (c = 0; c < size; c++)
        if (qr.modules[r][c]) parts.push('M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z');
    var fg = opts.dark || '#0b1220';
    var bg = opts.light || '#ffffff';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="Codigo QR">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + bg + '"/>' +
      '<path d="' + parts.join('') + '" fill="' + fg + '"/></svg>';
  }

  var api = { makeMatrix: makeMatrix, svg: svg, version: '1.0.0' };
  root.RSQR = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));

/* Export ESM para el Worker (ademas de globalThis.RSQR). */
var RSQR_EXPORT = (typeof globalThis !== 'undefined' ? globalThis : {}).RSQR;
export { RSQR_EXPORT as RSQR };
export default RSQR_EXPORT;
