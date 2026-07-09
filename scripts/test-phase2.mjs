#!/usr/bin/env node
// Self-contained Phase 2 test suite.
// Builds synthetic noteTextMsg protobuf buffers and runs applyTodoMarkers logic
// inline (no exports needed from notesStore). Also tests real DB notes.

// ── Inline protobuf helpers (mirrors the fixed notesStore versions) ────────────

function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * (2 ** shift); // multiplication — no 32-bit truncation
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: result, pos };
}

function findField(buf, fieldNum) {
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wt = tagR.value & 0x7;
    const fn = tagR.value >> 3;
    if (wt === 0) { pos = readVarint(buf, pos).pos; }
    else if (wt === 1) { pos += 8; }
    else if (wt === 2) {
      const lenR = readVarint(buf, pos); pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      if (fn === fieldNum) return buf.slice(pos, pos + len);
      pos += len;
    } else if (wt === 5) { pos += 4; }
    else break;
  }
  return null;
}

function findAllField(buf, fieldNum) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wt = tagR.value & 0x7;
    const fn = tagR.value >> 3;
    if (wt === 0) { pos = readVarint(buf, pos).pos; }
    else if (wt === 1) { pos += 8; }
    else if (wt === 2) {
      const lenR = readVarint(buf, pos); pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      if (fn === fieldNum) out.push(buf.slice(pos, pos + len));
      pos += len;
    } else if (wt === 5) { pos += 4; }
    else break;
  }
  return out;
}

function getVarintField(buf, fieldNum) {
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wt = tagR.value & 0x7;
    const fn = tagR.value >> 3;
    if (wt === 0) {
      const r = readVarint(buf, pos); pos = r.pos;
      if (fn === fieldNum) return r.value;
    } else if (wt === 1) { pos += 8; }
    else if (wt === 2) {
      const lenR = readVarint(buf, pos); pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      pos += len;
    } else if (wt === 5) { pos += 4; }
    else break;
  }
  return null;
}

function applyTodoMarkers(text, noteTextMsg) {
  const paraEntries = findAllField(noteTextMsg, 5);
  if (paraEntries.length === 0) return text;
  const todoAt = new Array(text.length + 1).fill(null);
  let charPos = 0;
  for (const entry of paraEntries) {
    const len = getVarintField(entry, 1) ?? 0;
    if (len <= 0) continue;
    const f2 = findField(entry, 2);
    if (f2) {
      const todoRef = findField(f2, 5);
      if (todoRef) {
        const done = (getVarintField(todoRef, 2) ?? 0) === 1;
        const end = Math.min(charPos + len, todoAt.length);
        for (let i = charPos; i < end; i++) todoAt[i] = done;
      }
    }
    charPos += len;
  }
  const lines = text.split('\n');
  let lineStart = 0;
  const out = [];
  for (const line of lines) {
    const state = lineStart < todoAt.length ? todoAt[lineStart] : null;
    out.push(state !== null && line.length > 0
      ? (state ? '- [x] ' : '- [ ] ') + line.trimEnd()
      : line.trimEnd());
    lineStart += line.length + 1;
  }
  return out.join('\n');
}

// ── Protobuf builder helpers ───────────────────────────────────────────────────

function encodeVarint(n) {
  const bytes = [];
  while (n > 127) { bytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

// length-delimited field: (fieldNum << 3 | 2) + varint(len) + data
function ld(fieldNum, data) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(data.length), data]);
}

// varint field: (fieldNum << 3 | 0) + varint(value)
function vf(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function todoEntry(charLen, done) {
  const uuid = Buffer.alloc(16, 0);
  const todoRef = Buffer.concat([ld(1, uuid), vf(2, done ? 1 : 0)]);
  return Buffer.concat([vf(1, charLen), ld(2, ld(5, todoRef))]);
}

function plainEntry(charLen) {
  return vf(1, charLen);
}

// Build a full noteTextMsg buffer with text (field2) + para entries (field5 repeated)
function buildNoteTextMsg(text, entries) {
  return Buffer.concat([ld(2, Buffer.from(text, 'utf8')), ...entries.map(e => ld(5, e))]);
}

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Section 1: Varint safety ───────────────────────────────────────────────────

console.log('\n=== 1. Varint safety ===');

// Build a noteTextMsg where the text runs 300 chars of plain text THEN a 5-char checklist item.
// cumulative charPos for the checklist entry = 300, which requires a 2-byte varint (0xAC 0x02).
// With the old |= << version, shift=7 is fine. The fix matters for shift >= 32 (varint byte 5+).
// To exercise the bug range: create charLen = 2^29 + 1 (won't match any real text, but tests the math).
{
  const bigN = 2 ** 29 + 1;
  const enc = encodeVarint(bigN);
  const decoded = readVarint(enc, 0);
  test('encode/decode 2^29+1 roundtrip', decoded.value, bigN);
}
{
  const bigN = 2 ** 35 + 7; // 5-byte varint territory
  const enc = encodeVarint(bigN);
  const decoded = readVarint(enc, 0);
  test('encode/decode 2^35+7 roundtrip', decoded.value, bigN);
}

// Alignment test: 300 plain chars then a 5-char checklist item.
// The para entry for the checklist has charLen=5 at position 300 in the string.
{
  const plain300 = 'a'.repeat(299) + '\n'; // 300 chars
  const checkItem = 'Done!';               // 5 chars, no trailing \n
  const text = plain300 + checkItem;
  const msg = buildNoteTextMsg(text, [
    plainEntry(300),
    todoEntry(5, true),
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('long-body: plain section unchanged (first line)', lines[0], 'a'.repeat(299));
  test('long-body: checklist on last line', lines[lines.length - 1], '- [x] Done!');
}

// ── Section 2: Edge case A — checklist as very first line ─────────────────────

console.log('\n=== 2a. Checklist as first line ===');
{
  const text = 'First\nSecond\nPlain';
  const msg = buildNoteTextMsg(text, [
    todoEntry(6, true),  // 'First\n' = 6 chars
    todoEntry(7, false), // 'Second\n' = 7 chars
    plainEntry(5),       // 'Plain' = 5 chars
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('first line gets - [x]', lines[0], '- [x] First');
  test('second line gets - [ ]', lines[1], '- [ ] Second');
  test('third line is plain', lines[2], 'Plain');
}

// ── Section 3: Edge case B — checklist as very last line, no trailing \n ──────

console.log('\n=== 2b. Checklist as last line (no trailing newline) ===');
{
  const text = 'Plain line\nLast item';
  const msg = buildNoteTextMsg(text, [
    plainEntry(11), // 'Plain line\n' = 11 chars
    todoEntry(9, false), // 'Last item' = 9 chars, no \n
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('plain first line', lines[0], 'Plain line');
  test('last line gets - [ ]', lines[1], '- [ ] Last item');
}

// ── Section 4: Edge case C — consecutive checklists, no separator ─────────────

console.log('\n=== 2c. Consecutive checklists ===');
{
  const text = 'Item1\nItem2\nItem3';
  const msg = buildNoteTextMsg(text, [
    todoEntry(6, true),   // 'Item1\n'
    todoEntry(6, false),  // 'Item2\n'
    todoEntry(5, true),   // 'Item3'
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('item1 checked', lines[0], '- [x] Item1');
  test('item2 unchecked', lines[1], '- [ ] Item2');
  test('item3 checked', lines[2], '- [x] Item3');
}

// ── Section 5: Edge case D — multi-byte UTF-8 chars in checklist items ────────

console.log('\n=== 2d. Multi-byte UTF-8 in checklist items ===');

// BMP multi-byte: é (U+00E9, 2 bytes UTF-8, 1 JS char), — (U+2014, 3 bytes UTF-8, 1 JS char)
{
  // "Café\n" = 5 JS chars (C,a,f,é,\n)
  // "Naïve\n" = 6 JS chars (N,a,ï,v,e,\n)
  // "Cost — free" = 11 JS chars
  const text = 'Café\nNaïve\nCost — free';
  const msg = buildNoteTextMsg(text, [
    todoEntry(5, true),   // 'Café\n' = 5 JS chars
    todoEntry(6, false),  // 'Naïve\n' = 6 JS chars
    plainEntry(11),       // 'Cost — free'
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('BMP accented: Café checked', lines[0], '- [x] Café');
  test('BMP accented: Naïve unchecked', lines[1], '- [ ] Naïve');
  test('BMP em-dash: plain unchanged', lines[2], 'Cost — free');
}

// Emoji (U+1F600 = 😀, 4 bytes UTF-8, 2 JS chars via surrogate pair).
// Apple Notes NSString.length uses UTF-16 code units, so emoji = 2 (matches JS).
{
  // "😀 Hi\n" = 6 JS chars (surrogate_high, surrogate_low, space, H, i, \n)
  const emoji = '😀';
  const line1 = emoji + ' Hi\n'; // 6 JS chars
  const line2 = 'Done!';         // 5 JS chars
  const text = line1 + line2;
  const msg = buildNoteTextMsg(text, [
    todoEntry(6, false), // emoji counts as 2 JS chars (UTF-16 units)
    todoEntry(5, true),
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('emoji (UTF-16): line with emoji unchecked', lines[0], '- [ ] 😀 Hi');
  test('emoji (UTF-16): Done! checked', lines[1], '- [x] Done!');
}

// ── Section 6: Empty and edge bodies ──────────────────────────────────────────

console.log('\n=== 3. Empty / edge bodies ===');

// Empty string — no entries
{
  const msg = buildNoteTextMsg('', []);
  test('empty text + no entries', applyTodoMarkers('', msg), '');
}

// Empty string — entries present but text is empty
{
  const msg = buildNoteTextMsg('', [todoEntry(0, false)]);
  test('empty text + zero-len entry', applyTodoMarkers('', msg), '');
}

// Only checkboxes — no plain text
{
  const text = 'Only\nCheckboxes';
  const msg = buildNoteTextMsg(text, [
    todoEntry(5, true),  // 'Only\n'
    todoEntry(9, false), // 'Checkboxes'
  ]);
  const result = applyTodoMarkers(text, msg);
  test('only checkboxes: first', result.split('\n')[0], '- [x] Only');
  test('only checkboxes: second', result.split('\n')[1], '- [ ] Checkboxes');
}

// Title-only note (no field5 entries at all)
{
  const text = 'Just a title';
  const msg = buildNoteTextMsg(text, []); // no field5 entries
  test('no para entries: text returned unchanged', applyTodoMarkers(text, msg), 'Just a title');
}

// ── Section 7: Fallback path — decodeNoteBody with garbage data ───────────────

console.log('\n=== 4. Fallback path (decodeNoteBody with garbage) ===');

import { createRequire } from 'module';
import { createGunzip } from 'zlib';
import { gunzipSync, inflateSync, deflateSync } from 'zlib';

// Inline version of decodeNoteBody for testing — mirrors notesStore.ts's
// decodeNoteBody exactly, including the applyTodoMarkers pass, so the
// "pinned fixture" tests below exercise the same full pipeline production
// code runs (gunzip -> field2 -> field3 -> field2 text -> checklist markers),
// not just the field-navigation error branches.
function decodeNoteBody(data) {
  let decompressed;
  try { decompressed = gunzipSync(data); }
  catch { try { decompressed = inflateSync(data); } catch { return 'FALLBACK_TRIGGERED'; } }
  const outerDoc = findField(decompressed, 2);
  if (!outerDoc) return 'FIELD2_MISSING';
  const noteTextMsg = findField(outerDoc, 3);
  if (!noteTextMsg) return 'FIELD3_MISSING';
  const textBytes = findField(noteTextMsg, 2);
  if (!textBytes) return 'TEXTFIELD_MISSING';
  return applyTodoMarkers(textBytes.toString('utf8'), noteTextMsg);
}

test('garbage blob → fallback triggered (empty string from real fn)', decodeNoteBody(Buffer.from('this is garbage')), 'FALLBACK_TRIGGERED');
test('empty blob → fallback triggered', decodeNoteBody(Buffer.from('')), 'FALLBACK_TRIGGERED');

// Valid gzip but missing field2 in outer doc
import { gzipSync } from 'zlib';
{
  // A valid gzip of a protobuf that has field3 at top level instead of field2
  const inner = Buffer.concat([vf(3, 99)]); // field3 varint at top level — no field2
  const blob = gzipSync(inner);
  test('valid gzip but no outer field2 → FIELD2_MISSING', decodeNoteBody(blob), 'FIELD2_MISSING');
}

// ── Section 7b: Pinned full-pipeline fixtures ──────────────────────────────────
// Full gzip(top-level field2 -> outer-doc field3 -> note_text field2 text,
// field5 checklist entries) documents, built once and asserted byte-for-byte —
// exercises the whole decode pipeline end to end without depending on the
// live Notes.app database (unlike the "Real DB notes" section below, which
// only works on the original author's machine).

console.log('\n=== 4b. Pinned full-pipeline fixtures ===');

function buildTopLevelBlob(noteTextMsg) {
  const outerDoc = ld(3, noteTextMsg); // outer-doc field 3 = note_text_message
  const topLevel = ld(2, outerDoc); // top-level field 2 = outer document
  return gzipSync(topLevel);
}

{
  // Plain note, no checklist entries at all.
  const text = 'Shopping list\nMilk\nEggs';
  const msg = buildNoteTextMsg(text, []);
  const blob = buildTopLevelBlob(msg);
  test('pinned fixture: plain note round-trips unchanged', decodeNoteBody(blob), text);
}

{
  // Mixed checklist + plain paragraph, gzip-compressed exactly as Notes.app stores it.
  const text = 'Groceries\nBuy milk\nBuy eggs\nRemember reusable bags';
  const msg = buildNoteTextMsg(text, [
    plainEntry(10),      // 'Groceries\n'
    todoEntry(9, true),  // 'Buy milk\n'
    todoEntry(9, false), // 'Buy eggs\n'
    plainEntry(23),      // 'Remember reusable bags'
  ]);
  const blob = buildTopLevelBlob(msg);
  const result = decodeNoteBody(blob);
  const lines = result.split('\n');
  test('pinned fixture: title line unchanged', lines[0], 'Groceries');
  test('pinned fixture: checked item', lines[1], '- [x] Buy milk');
  test('pinned fixture: unchecked item', lines[2], '- [ ] Buy eggs');
  test('pinned fixture: trailing plain paragraph unchanged', lines[3], 'Remember reusable bags');
}

{
  // zlib-deflate fallback path — decodeNoteBody tries gunzip first, then
  // inflateSync, before giving up. Confirms the fallback branch also runs the
  // same field-navigation + checklist-marker pipeline, not just gunzip's.
  const text = 'Deflate path\nItem one';
  const msg = buildNoteTextMsg(text, [plainEntry(13), todoEntry(8, true)]);
  const outerDoc = ld(3, msg);
  const topLevel = ld(2, outerDoc);
  const blob = deflateSync(topLevel);
  const result = decodeNoteBody(blob);
  test('pinned fixture: inflate-fallback path decodes correctly', result, 'Deflate path\n- [x] Item one');
}

// ── Section 8: Right-trim cosmetic ────────────────────────────────────────────

console.log('\n=== 5. Right-trim per line ===');
{
  const text = 'Four   \nFive\n';
  const msg = buildNoteTextMsg(text, [
    todoEntry(8, false), // 'Four   \n' = 8 chars
    todoEntry(5, false), // 'Five\n' = 5 chars
    plainEntry(0),       // trailing empty
  ]);
  const result = applyTodoMarkers(text, msg);
  const lines = result.split('\n');
  test('trailing spaces stripped from todo line', lines[0], '- [ ] Four');
  test('no-trailing-space line unchanged', lines[1], '- [ ] Five');
}

// ── Section 9: Real DB notes ──────────────────────────────────────────────────

console.log('\n=== 6. Real DB notes ===');

const { readNoteById } = await import('../dist/notesStore.js');

// p9875 — checklist note
{
  const note = readNoteById(9875);
  const lines = note?.body.split('\n') ?? [];
  const oneIdx = lines.findIndex(l => l === '- [x] One');
  const twoIdx = lines.findIndex(l => l === '- [ ] Two');
  const threeIdx = lines.findIndex(l => l === '- [ ] Three');
  const fourIdx = lines.findIndex(l => l === '- [ ] Four');
  const fiveIdx = lines.findIndex(l => l === '- [ ] Five');
  test('p9875: - [x] One present', oneIdx >= 0 ? 'yes' : 'no', 'yes');
  test('p9875: - [ ] Two present', twoIdx >= 0 ? 'yes' : 'no', 'yes');
  test('p9875: - [ ] Three present', threeIdx >= 0 ? 'yes' : 'no', 'yes');
  test('p9875: - [ ] Four present (trimmed)', fourIdx >= 0 ? 'yes' : 'no', 'yes');
  test('p9875: - [ ] Five present', fiveIdx >= 0 ? 'yes' : 'no', 'yes');
  const hasStrayMarker = lines.some(l => (l.startsWith('- [x] ') || l.startsWith('- [ ] ')) &&
    !['One','Two','Three','Four','Five'].includes(l.replace(/^- \[.\] /, '')));
  test('p9875: no stray markers on plain lines', hasStrayMarker ? 'stray' : 'clean', 'clean');
}

// p9656 — dash-list note (isTodo=false for all entries)
{
  const note = readNoteById(9656);
  const body = note?.body ?? '';
  const hasMarker = /^- \[[x ]\] /m.test(body);
  test('p9656: no todo markers injected', hasMarker ? 'has-markers' : 'clean', 'clean');
}

// p9858 — plain note
{
  const note = readNoteById(9858);
  const body = note?.body ?? '';
  const hasMarker = /^- \[[x ]\] /m.test(body);
  test('p9858: no todo markers injected', hasMarker ? 'has-markers' : 'clean', 'clean');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
