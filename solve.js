// A fast drop-in replacement for csv-reader 1.0.0's readCsv: same answers, byte for byte,
// reached by scanning for delimiters with indexOf and slicing whole runs at once instead of
// building every field one character at a time. The next LF and CR positions are cached and
// shared by every field of a line, so the common field pays for one short scan to its comma.
// The broken-row policy is csv-reader's own:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a quoted field runs to the next quote that is not doubled, "" inside it is one quote,
//     each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to the
//     next comma or line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after it is read again as
//     unquoted (unterminated_quote);
//   - columns is the first record when header is true, else null; rows are padded with ""
//     (short_row) or cut (long_row) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record
//     starts on, row its record's index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text[0] === '\uFEFF') pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Cached positions of the next LF and next CR at or after the point they were computed;
  // -1 means "not computed", Infinity means "none left". Invalidated by setting them back
  // to -1 whenever pos may have moved past them in a way the reader did not track.
  let nextLF = -1;
  let nextCR = -1;
  function lf() {
    if (nextLF < 0) {
      const i = text.indexOf('\n', pos);
      nextLF = i < 0 ? Infinity : i;
    }
    return nextLF;
  }
  function cr() {
    if (nextCR < 0) {
      const i = text.indexOf('\r', pos);
      nextCR = i < 0 ? Infinity : i;
    }
    return nextCR;
  }

  // How the last field read ended, and how many characters it kept past its seed.
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `seed` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns the field's value.
  function readUnquoted(seed) {
    let value = seed;
    let added = 0;
    let segStart = pos;
    while (true) {
      let ic = text.indexOf(',', pos);
      if (ic < 0) ic = Infinity;
      const i = Math.min(ic, lf(), cr());
      if (i === Infinity) {
        if (len > segStart) {
          const seg = text.slice(segStart, len);
          value += seg;
          added += seg.length;
        }
        pos = len;
        fEnded = END;
        fAdded = added;
        return value;
      }
      const ch = text[i];
      if (ch === ',') {
        if (i > segStart) {
          const seg = text.slice(segStart, i);
          value += seg;
          added += seg.length;
        }
        pos = i + 1;
        nextLF = -1;
        nextCR = -1;
        fEnded = COMMA;
        fAdded = added;
        return value;
      }
      if (ch === '\n') {
        if (i > segStart) {
          const seg = text.slice(segStart, i);
          value += seg;
          added += seg.length;
        }
        pos = i + 1;
        line += 1;
        nextLF = -1;
        nextCR = -1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      // ch is '\r'
      if (text[i + 1] === '\n') {
        if (i > segStart) {
          const seg = text.slice(segStart, i);
          value += seg;
          added += seg.length;
        }
        pos = i + 2;
        line += 1;
        nextLF = -1;
        nextCR = -1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      // A lone CR is dropped (stray_cr) and the field goes on.
      if (i > segStart) {
        const seg = text.slice(segStart, i);
        value += seg;
        added += seg.length;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = i + 1;
      segStart = pos;
      nextCR = -1; // nextLF is still ahead of pos, keep it
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field's value.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    pos += 1;
    nextLF = -1;
    nextCR = -1;
    let closed = false;
    while (pos < len) {
      let iq = text.indexOf('"', pos);
      if (iq < 0) iq = Infinity;
      const ir = cr();
      const i = Math.min(iq, ir);
      if (i === Infinity) {
        countAndPush(parts, pos, len);
        pos = len;
        break;
      }
      if (i > pos) countAndPush(parts, pos, i);
      if (text[i] === '"') {
        if (text[i + 1] === '"') {
          parts.push('"');
          pos = i + 2;
          nextCR = -1;
          continue;
        }
        pos = i + 1;
        nextLF = -1;
        nextCR = -1;
        closed = true;
        break;
      }
      // '\r' inside quotes: CRLF and a lone CR are each read as one LF.
      parts.push('\n');
      line += 1;
      pos = text[i + 1] === '\n' ? i + 2 : i + 1;
      nextLF = -1;
      nextCR = -1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted.
      pos = open + 1;
      line = openLine;
      nextLF = -1;
      nextCR = -1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const value = parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts.join('');
    if (pos >= len) {
      fEnded = END;
      return value;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      nextLF = -1;
      nextCR = -1;
      fEnded = COMMA;
      return value;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      nextLF = -1;
      nextCR = -1;
      fEnded = LINE_BREAK;
      return value;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      nextLF = -1;
      nextCR = -1;
      fEnded = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break.
    const junkValue = readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junkValue;
  }

  // Pushes text[from, to) onto parts, counting the LFs inside it into `line`.
  function countAndPush(parts, from, to) {
    let s = from;
    while (true) {
      const j = text.indexOf('\n', s);
      if (j < 0 || j >= to) break;
      line += 1;
      s = j + 1;
    }
    parts.push(text.slice(from, to));
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;
    nextLF = -1;
    nextCR = -1;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let value;
    let quoted;
    do {
      quoted = text[pos] === '"';
      value = quoted ? readQuoted() : readUnquoted('');
      fields.push(value);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
