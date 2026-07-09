#!/usr/bin/env node
// Schema-detection sanity tests, run against whatever Notes.app database
// happens to be present. Unlike test-phase2.mjs's protobuf-decoder tests,
// these can't be pinned to a fixture blob — schema detection (detectSchema
// in notesStore.ts) is inherently about the live installed macOS/Notes.app
// version's ZICCLOUDSYNCINGOBJECT column layout, which isn't something we
// can construct synthetically without duplicating that logic. So instead
// these assert invariants that must hold on ANY real Notes library, not
// specific data — same live-DB caveat as test-phase2.mjs's "Real DB notes"
// section: requires Full Disk Access, and needs at least one real folder/note
// to exercise the non-empty-library assertions.

import { readFolders, readAllNotes } from '../dist/notesStore.js';

let passed = 0, failed = 0;
function test(name, cond) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

console.log('\n=== Schema detection sanity (live DB) ===');

const folders = readFolders();
test('readFolders() returns an array', Array.isArray(folders));
test('at least one folder detected (every real Notes library has "Notes")', folders.length > 0);

if (folders.length > 0) {
  const f = folders[0];
  test('folder has non-empty id', typeof f.id === 'string' && f.id.length > 0);
  test('folder has non-empty name', typeof f.name === 'string' && f.name.length > 0);
  test('folder path ends with its own name', f.path.endsWith(f.name));
  test('folder account is a string (possibly empty if undetectable)', typeof f.account === 'string');
  test('folder noteCount is a non-negative number', typeof f.noteCount === 'number' && f.noteCount >= 0);
  test('isSmartFolder is a boolean', typeof f.isSmartFolder === 'boolean');

  // colAccount detection: at least one real folder should resolve to a
  // non-empty account name (iCloud / On My Mac / etc) on any real library —
  // an all-empty result across every folder would mean the ZACCOUNT* column
  // candidate detection silently failed for this macOS version.
  const anyAccountResolved = folders.some((x) => x.account !== '');
  test('at least one folder resolves a non-empty account name', anyAccountResolved);

  // "Recently Deleted" is a real, always-present folder that must be
  // excluded from readFolders() (see recentlyDeletedPk detection).
  const rdTitles = ['Recently Deleted', 'Onlangs verwijderd', 'Recent verwijderd', 'Recentelijk verwijderd'];
  test('Recently Deleted is excluded from readFolders()', !folders.some((x) => rdTitles.includes(x.name)));
}

const notes = readAllNotes(false);
test('readAllNotes() returns an array', Array.isArray(notes));

if (notes.length > 0) {
  const n = notes[0];
  test('note id uses the x-coredata ICNote scheme (storeUuid resolved)', n.id.includes('ICNote/p') || n.id.startsWith('icnote:'));
  test('note pinned is a boolean', typeof n.pinned === 'boolean');
  test('note creationDate parses as a valid date or is empty', n.creationDate === '' || !isNaN(Date.parse(n.creationDate)));
  test('note modificationDate parses as a valid date or is empty', n.modificationDate === '' || !isNaN(Date.parse(n.modificationDate)));
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
