import './style.css';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EntryIds, SceneBreak, sectionName, SECTION_NAMES } from './schema.js';
import { isMac, keyLabel, showKeysForThisComputer } from './keys.js';
import { StatsPanel, record as recordProgress } from './stats.js';
import { AltMark, ParagraphVersions, AltPanel, flip, newParagraphVersion, altsHere } from './alts.js';
import { ChapterStore } from './chapter.js';
import { NotesLayer } from './notes.js';
import { BlockHandle } from './blocks.js';
import { bySort } from './order.js';
import { getMeta, setMeta, putEntries, children, getEntry, snapshots, byKind, onLocalWrites, forgetDeleted, isTrashed, topTags } from './db.js';
import { trash, restore, trashed, deleteForever, contents } from './trash.js';
import { searchIndex, searchChanged } from './search.js';
import { keep, versionsOf, tidyHistory, blocks as docBlocks, compare, deletedFrom, bringBack } from './history.js';
import { popMenu, menuButton, onContextMenu, ask, askText, askPiece, askScript, showCopy, toast, closeMenu } from './menu.js';
import { Sync } from './sync.js';
import { ensureSeed, outline, entry, wordCount, noteTypes } from './model.js';
import { chapterMarkdown, bookMarkdown, download } from './export.js';
import { EntryRef, TagMarks } from './outline.js';
import { retitleLinks, freshenRefs } from './links.js';
import { keepStorage, oldestUnsent, unsentLabel, unsentFilesLabel, spaceWarning, mb, STALE_AFTER } from './keep.js';
import { setMoveHooks, moveEntries } from './move.js';
import { Conflicts } from './conflicts.js';
import { FileEmbed, insertFiles, resetLinkPics } from './filenode.js';
import { MAX_BYTES, SPACE, spaceUsed, unsentFiles } from './files.js';
import { vaultZip, vaultFiles, pageMarkdown } from './vault.js';
import { ScriptElements, ELEMENTS, elementLabel, scriptPages, toFountain, fromFountain, fromOutline, looksLikeOutline, SceneCodes, NUMBER_SCENES, assignCodes, codeOrder } from './script.js';
import { Notebook, rootOf, titleOf, dayId, renderLinkedFrom } from './notebook.js';
import { moveLine, toggleDone, foldKey } from './outline.js';
import { SlashMenu, setSlashItems } from './slash.js';
import { openHandleMenu } from './handlemenu.js';
import { openPicker } from './picker.js';
import { PlotGrid, threadsOf, worldPromises } from './grid.js';
import { ProductionView } from './prodview.js';
import { CaptureScreen, writeOutPending, recoverRecording } from './capture.js';
import { onVoiceChip, switchVoice, voiceText, voiceInfo, knownModes, fetchModes, placeDraft, placeVoice, RAW } from './voice.js';
import { takeShares, snapshotPending } from './share.js';
import { LISTS, listOf, setList, fillList } from './lists.js';
import { sendToDaybook, sendPending, queueTask } from './daybook.js';
import { meetingPending, addMeetingFile, meetingFromLine, audioOn, renameSpeaker, speakersOn, mine } from './meeting.js';
import { DayReview, getReview } from './review.js';
import { TagsPage } from './tags.js';
import { FONTS, FONT_GROUPS, DEFAULT_FONT, setFont, currentFont, loadPreviews } from './fonts.js';
import { pieceDoc, pageDoc, startDraft, draftHolding } from './drafts.js';
import { printPiece } from './print.js';
import { CompareView, BesidePane } from './compare.js';
import { claudeNotes, TalkPanel } from './claudenotes.js';
import { Sharing, linkFor, commentsOn } from './sharelink.js';
import { ensureAreas, areas, books, bookType, hasManuscript, kindName, areaColor, newArea, newBook, pagesIn, loosePages, bookOf, newPage, stats, dailyMentions, ago, changeType, worlds, worldOf, newWorld, newPiece, piecesIn, worldTree, worldStats, usedLabels, ensureWorlds, editedAt, FORMATS, formatName, defaultLabel, STAGES, stageOf } from './library.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const root = document.documentElement;
const extensions = [
  // No lists or block quotes in a manuscript: they hold paragraphs the chapter
  // can't save as its own (typing "- " made a list whose words were lost).
  StarterKit.configure({ codeBlock: false, code: false, horizontalRule: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, blockquote: false }), EntryIds, SceneBreak.configure({ names: () => sectionNames() }), AltMark, ParagraphVersions,
  EntryRef.configure({ onPick: openPicker, onOpen: openEntry }),
  TagMarks.configure({ onTag: (t) => notebook.showTag(t) }),
  ScriptElements.configure({ isScript: () => isScript() }),
  SceneCodes.configure({ numbering: () => (isScript() && state.project?.fields?.numbered ? numbering : null) }),
  FileEmbed.configure({ onTooBig: tooBig }), SlashMenu
];
// The scene numbers in the numbered script's other chapters, around the one open.
let numbering = { before: null, after: null, used: [] };
const isScript = () => root.classList.contains('script');
// What the levels of a script's sections are called (Act, Sequence, Scene…), per piece.
const sectionNames = () => state.project?.fields?.sections || SECTION_NAMES;
function tooBig(f) { toast(`“${f.name}” is too big to add (the limit is ${Math.round(MAX_BYTES / 1048576)} MB)`); }
// Deleted, missing, or in the Trash.
const gone = (r) => !r || r.deleted || isTrashed(r);

// project: the piece open in the manuscript view. bookId: the piece whose home is
// shown. worldId: the world whose home is shown.
const state = { project: null, acts: [], chapterId: null, bookId: null, worldId: null, gridId: null, prodId: null, compareId: null, libArea: null };
// The plot grid wrote to the open chapter's entries: read it afresh on the way back.
let gridTouched = false;
const view = () => root.dataset.view || 'write';
const inNotebook = () => view() === 'notebook';

const statusEl = $('#status');
const store = new ChapterStore((s) => {
  statusEl.textContent = s === 'saving' ? 'Saving…' : s === 'error' ? 'Not saved — check storage' : 'Saved';
  statusEl.classList.toggle('error', s === 'error');
});

const editor = new Editor({
  element: $('#editor'),
  extensions,
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  onUpdate: ({ editor: ed }) => {
    store.change(ed.state.doc);
    notes.layout();
    refreshWords();
    scheduleScenes();
  }
});
window.__editor = editor;

const notes = new NotesLayer($('.notes-layer'), editor);
// Alternates, with Claude's suggestions when you're signed in and online.
// Tests stand in for Claude with window.__claude.
const alts = new AltPanel(editor, {
  ask: (body) => (window.__claude ? window.__claude(body) : sync.invoke('inkwell', body)),
  canAsk: () => !!window.__claude || (!!sync.user && navigator.onLine && !!sync.backend?.invoke),
  context: async () => {
    const chapter = state.chapterId ? await getEntry(state.chapterId) : null;
    const world = state.project ? await worldOf(state.project) : null;
    const pages = state.project ? [...(await pagesIn(state.project.id)), ...(world ? await pagesIn(world.id) : [])] : [];
    const idea = pages.find((p) => /^idea$/i.test(p.title || ''));
    return { book: state.project?.title || '', chapter: chapter?.title || '', idea: idea ? await pageMarkdown(idea) : '' };
  }
});

const isText = (n) => n.type.name === 'paragraph' || n.type.name === 'heading';
// The six-dot handle's menu for a paragraph (or script line). Same order as
// the notebook's: work on this one, turn into, add above, move, delete.
function paragraphMenu({ node, index, count, handle }) {
  const script = isScript();
  const kind = node.type.name;
  const text = isText(node);
  const el = kind === 'paragraph' ? node.attrs.el || 'action' : null;
  const at = (fn) => () => fn(handle.range(index).from);
  const into = (fn) => at((from) => fn(editor.chain().setTextSelection(from + 1)).focus().run());
  const title = kind === 'heading' ? 'Heading' : kind === 'sceneBreak' ? (script ? 'Section' : 'Scene break') : script ? elementLabel(el) : 'Paragraph';
  const depthChips = kind === 'sceneBreak' && script
    ? { label: 'Turn into', chips: [1, 2, 3, ...(node.attrs.level > 3 ? [node.attrs.level] : [])].map((l) => ({ label: sectionName(l, sectionNames()), current: (node.attrs.level || 1) === l, run: at((from) => editor.view.dispatch(editor.state.tr.setNodeMarkup(from, undefined, { ...editor.state.doc.nodeAt(from).attrs, level: l }))) })) }
    : null;
  const turn = depthChips || (!text ? null : script
    ? { label: 'Turn into', chips: ELEMENTS.map((x) => ({ label: x.short || x.label, current: el === x.id, run: into((c) => (kind === 'heading' ? c.setNode('paragraph') : c).updateAttributes('paragraph', { el: x.id })) })) }
    : { label: 'Turn into', chips: [
      { label: 'Paragraph', current: kind === 'paragraph', run: into((c) => c.setNode('paragraph')) },
      { label: 'Heading', current: kind === 'heading', run: into((c) => c.setNode('heading', { level: 2 })) }
    ] });
  return {
    title,
    sections: [
      [
        text && { label: 'Add a note', keys: '⌘⇧N', run: () => notes.add(node.attrs.eid) },
        text && { label: script ? 'Versions of this line' : 'Versions of this paragraph', run: at((from) => { editor.chain().setTextSelection(from + 1).focus().run(); alts.open({ scope: 'para' }); }) },
        text && { label: 'New version to rewrite', keys: '⌘⇧D', run: at((from) => { editor.chain().setTextSelection(from + 1).focus().run(); newParagraphVersion(editor); }) }
      ],
      [turn],
      [script
        ? { label: 'Section above', run: at((from) => insertSection(from)) }
        : { label: 'Scene break above', run: at((from) => editor.chain().insertContentAt(from, { type: 'sceneBreak' }).focus().run()) }],
      [
        { label: 'Move up', keys: 'Alt+⇧↑', stay: true, half: 'move', off: index === 0, run: () => handle.move(index, index - 1) },
        { label: 'Move down', keys: 'Alt+⇧↓', stay: true, half: 'move', off: index >= count - 1, run: () => handle.move(index, index + 2) },
        node.attrs.eid && { label: 'Move to…', run: () => setTimeout(() => sendSelectionPicker([node.attrs.eid]), 120) }
      ],
      [{ label: 'Delete', danger: true, run: () => {
        const { from, to } = handle.range(index);
        if (editor.state.doc.childCount > 1) editor.chain().deleteRange({ from, to }).focus().run();
        else editor.chain().setContent({ type: 'doc', content: [{ type: 'paragraph' }] }).focus().run();
        toast(`${title} deleted`, { label: 'Undo', run: () => editor.chain().focus().undo().run() });
      } }]
    ]
  };
}
// A new section in a script, at the same depth as the one it follows (a
// scene after a scene), ready to name. Tab in its name goes a level deeper.
function insertSection(at) {
  let level = 1;
  editor.state.doc.forEach((n, pos) => { if (pos < at && n.type.name === 'sceneBreak') level = n.attrs.level || 1; });
  editor.chain().insertContentAt(at, { type: 'sceneBreak', attrs: { level } }).run();
  requestAnimationFrame(() => editor.view.nodeDOM(at)?.querySelector('input')?.focus());
}
const blocks = new BlockHandle(editor, $('.sheet'), { menu: paragraphMenu });

// ---------- script bar ----------

// On a phone there's no Tab key, so a row of element buttons rides just above
// the keyboard while you write a script. Tapping one changes the line you're on.
// The alternates buttons sit at the far end of the same row (the whole row
// when it isn't a script), reached by scrolling it sideways.
const scriptBar = $('.script-bar');
const touch = matchMedia('(hover: none)');
function placeScriptBar() {
  const script = isScript();
  const withAlts = !root.classList.contains('hide-alts') && !root.classList.contains('focus');
  const show = touch.matches && (script || withAlts) && writing() && editor.isFocused;
  scriptBar.hidden = !show;
  scriptBar.classList.toggle('scripting', script);
  scriptBar.classList.toggle('no-alts', !withAlts);
  body.classList.toggle('script-bar-on', show);
  if (!show) return;
  const vv = window.visualViewport;
  const bottom = vv ? window.innerHeight - (vv.offsetTop + vv.height) : 0;
  scriptBar.style.bottom = `${Math.max(0, bottom)}px`;
  const p = editor.state.selection.$from.parent;
  const el = p.type.name === 'paragraph' ? p.attrs.el || 'action' : null;
  scriptBar.querySelectorAll('button[data-el]').forEach((b) => b.classList.toggle('current', b.dataset.el === el));
  if (!withAlts) return;
  const here = altsHere(editor.state);
  const button = (name) => scriptBar.querySelector(`[data-alt="${name}"]`);
  button('word').textContent = here.word ? `Alternates · ${here.word.n}` : 'Alternates';
  button('para').textContent = here.para ? `Paragraph ${here.para.i + 1} of ${here.para.n}` : 'Paragraph';
  button('word').classList.toggle('current', alts.isOpen && alts.scope === 'word');
  button('para').classList.toggle('current', alts.isOpen && alts.scope === 'para');
  for (const name of ['prev', 'next']) button(name).classList.toggle('idle', !here.word && !here.para);
}
// Types # or / at the caret, with a space before it if it would touch a word
// (the + on the phone rows types the / that opens the insert menu).
function typeHere(ed, ch) {
  const { $from } = ed.state.selection;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
  ed.chain().focus().insertContent(before && before !== ' ' ? ` ${ch}` : ch).run();
}

// The rows above the keyboard: a quick tap runs a button; holding (or sliding)
// scrolls the row instead, so a thumb resting on a button never sets it off.
// pointerdown is held back so the keyboard stays up.
const TAP_MS = 280;

// Room kept below the caret when the page scrolls to it: the row above the
// keyboard plus a line or so. (ProseMirror measures the visual viewport, which
// already ends at the keyboard, so the keyboard isn't counted again here.)
const ROOM_ABOVE = 60;
const ROOM_BELOW = 48;
const caretRoom = {
  top: ROOM_ABOVE, left: 5, right: 5,
  get bottom() {
    const bar = [scriptBar, $('.outline-bar')].find((b) => b && !b.hidden);
    return (bar ? bar.offsetHeight : 0) + ROOM_BELOW;
  }
};

function tapBar(bar, selector, run) {
  let start = null;
  let hold = null;
  const end = () => { clearTimeout(hold); bar.classList.remove('holding'); };
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const b = e.target.closest(selector);
    start = b ? { b, x: e.clientX, y: e.clientY, t: performance.now(), left: bar.scrollLeft } : null;
    clearTimeout(hold);
    hold = setTimeout(() => bar.classList.add('holding'), TAP_MS);
  });
  bar.addEventListener('pointerup', (e) => {
    end();
    const s = start;
    start = null;
    if (!s) return;
    const tap = performance.now() - s.t < TAP_MS && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10 && Math.abs(bar.scrollLeft - s.left) < 4;
    if (tap) { run(s.b); caretSoon(80); }
  });
  bar.addEventListener('pointercancel', () => { end(); start = null; });
}
tapBar(scriptBar, 'button[data-el], button[data-alt], button[data-ins], button[data-talk]', (b) => {
  const what = b.dataset.alt;
  if (b.dataset.talk) talkIntoDraft();
  else if (b.dataset.ins) typeHere(editor, '/');
  else if (what === 'word' || what === 'para') alts.toggle({ scope: what });
  else if (what === 'ask') {
    if (!alts.isOpen) alts.open({ scope: 'word' });
    alts.askClaude();
  } else if (what === 'prev' || what === 'next') flip(editor, what === 'prev' ? -1 : 1);
  else if (b.dataset.el === 'section') {
    insertSection(editor.state.selection.$from.before(1));
  } else editor.chain().focus().updateAttributes('paragraph', { el: b.dataset.el }).run();
  placeScriptBar();
});
editor.on('transaction', placeScriptBar);
editor.on('focus', placeScriptBar);
editor.on('blur', () => setTimeout(placeScriptBar, 50));
window.visualViewport?.addEventListener('resize', placeScriptBar);
window.visualViewport?.addEventListener('scroll', placeScriptBar);

// ---------- notebook ----------

let railTimer;
let tagsPage = null; // the Tags page (set up with capture, below)
let dayReview = null; // the day review under a day page (set up with capture, below)
const notebook = new Notebook({
  onPick: openPicker,
  onOpen: openEntry,
  onStatus: (s) => {
    if (inNotebook()) statusEl.textContent = s === 'saving' ? 'Saving…' : s === 'error' ? 'Not saved — check storage' : 'Saved';
    if (s === 'saved') { listSoon(); if (notebook?.isDay) dayReview?.soon(); }
  },
  onChange: () => { clearTimeout(railTimer); railTimer = setTimeout(renderRail, 100); },
  // A mirror edited a paragraph of the chapter that's open behind the notebook.
  onSources: (rows) => { if (rows.some((r) => r.parent_id === state.chapterId)) applyRemoteChapter(); },
  onPlace: (page) => {
    if (!inNotebook()) return;
    remember({ view: 'notebook', pageId: page.id, ...(notebook?.zoom ? { zoom: notebook.zoom } : {}) });
    dayReview?.show(page);
    $('#nb-more').replaceChildren(...(page.kind === 'page' ? [menuButton(() => pageMenu(page), 'More for this page')] : []));
    renderCrumb();
  },
  // Zooming in is a step you can go Back from.
  onZoom: (zoom) => {
    if (!inNotebook() || !notebook.page) return;
    remember({ view: 'notebook', pageId: notebook.page.id, ...(zoom ? { zoom } : {}) });
  }
});

// On a phone, a row above the keyboard for outlines: indent, move, tag, link, fold, zoom.
const outlineBar = $('.outline-bar');
function placeOutlineBar() {
  const show = touch.matches && inNotebook() && notebook.editor.isFocused;
  outlineBar.hidden = !show;
  body.classList.toggle('outline-bar-on', show);
  if (!show) return;
  const vv = window.visualViewport;
  outlineBar.style.bottom = `${Math.max(0, vv ? window.innerHeight - (vv.offsetTop + vv.height) : 0)}px`;
  const here = notebook.currentLine();
  const zoomOut = !!notebook.zoom && here === notebook.zoom;
  outlineBar.querySelector('[data-do="undo"]').disabled = !notebook.editor.can().undo();
  outlineBar.querySelector('[data-do="redo"]').disabled = !notebook.editor.can().redo();
  const z = outlineBar.querySelector('[data-do="zoom"]');
  z.textContent = zoomOut ? 'Out' : 'Zoom';
  z.setAttribute('aria-label', zoomOut ? 'Zoom out' : 'Zoom in');
}
tapBar(outlineBar, 'button[data-do]', (b) => {
  const ed = notebook.editor;
  const act = b.dataset.do;
  if (act === 'undo') ed.chain().focus().undo().run();
  else if (act === 'redo') ed.chain().focus().redo().run();
  else if (act === 'done') toggleDone(ed);
  else if (act === 'move') setTimeout(moveLinePicker, 120); // after the tap's click, so it doesn't land on the menu
  else if (act === 'indent') ed.chain().focus().sinkListItem('listItem').scrollIntoView().run();
  else if (act === 'outdent') ed.chain().focus().liftListItem('listItem').scrollIntoView().run();
  else if (act === 'up' || act === 'down') moveLine(ed, act === 'up' ? -1 : 1);
  else if (act === 'tag') typeHere(ed, '#');
  else if (act === 'insert') typeHere(ed, '/');
  else if (act === 'link') openPicker(ed);
  else if (act === 'zoom') { const here = notebook.currentLine(); notebook.zoomTo(notebook.zoom && here === notebook.zoom ? null : here); ed.commands.focus(); }
  placeOutlineBar();
});
// The six-dot handle's menu for a notebook line (a right-click on its handle,
// or a tap on a phone). Everything here also has a key or a button on the
// phone row; the menu is where you find them.
function findLine(eid) {
  let hit = null;
  notebook.editor.state.doc.descendants((n, pos) => {
    if (hit) return false;
    if (n.type.name === 'listItem' && n.attrs.eid === eid) { hit = { node: n, pos, $pos: notebook.editor.state.doc.resolve(pos) }; return false; }
    return true;
  });
  return hit;
}
function lineMenu(eid) {
  const ed = notebook.editor;
  const line = findLine(eid);
  if (!line) return { sections: [] };
  const { node, pos, $pos } = line;
  const kids = node.lastChild?.type.name === 'bulletList' ? node.lastChild : null;
  let under = 0;
  node.descendants((n) => { if (n.type.name === 'listItem') under++; });
  const folded = !!kids && foldKey.getState(ed.state)?.folded.has(eid);
  const index = $pos.index();
  const siblings = $pos.parent.childCount;
  const nested = $pos.depth > 1;
  const lines = (n) => `${n} line${n === 1 ? '' : 's'}`;
  // Line actions work on the line the caret is in, so put it there first.
  const here = () => {
    const now = findLine(eid);
    if (!now) return false;
    if (notebook.currentLine() !== eid) ed.commands.setTextSelection(now.pos + 1 + now.node.firstChild.nodeSize - 1);
    return true;
  };
  const on = (fn) => () => { if (here()) fn(); };
  const zoom = { label: 'Zoom in', run: () => { notebook.zoomTo(eid); ed.commands.focus(); } };
  const fold = kids && { label: folded ? `Unfold the ${lines(under)} under it` : `Fold the ${lines(under)} under it`, keys: folded ? '⌘↓' : '⌘↑', run: () => { ed.view.dispatch(ed.state.tr.setMeta(foldKey, { fold: eid, on: !folded })); ed.commands.focus(); } };
  return {
    title: `Line${under ? ` · ${lines(under)} under it` : ''}`,
    sections: [
      [
        // On a phone the handle covers the line's fold arrow, so Fold comes first there.
        ...(touch.matches ? [fold, zoom] : [zoom, fold]),
        { label: node.attrs.done ? 'Not done' : 'Mark done', keys: '⌘↵', run: on(() => { toggleDone(ed); ed.commands.focus(); }) }
      ],
      [
        { label: 'Outdent', keys: '⇧Tab', stay: true, half: 'indent', off: !nested, run: on(() => ed.chain().focus().liftListItem('listItem').scrollIntoView().run()) },
        { label: 'Indent', keys: 'Tab', stay: true, half: 'indent', off: index === 0, run: on(() => ed.chain().focus().sinkListItem('listItem').scrollIntoView().run()) },
        { label: 'Move up', keys: 'Alt+⇧↑', stay: true, half: 'move', off: index === 0, run: on(() => moveLine(ed, -1)) },
        { label: 'Move down', keys: 'Alt+⇧↓', stay: true, half: 'move', off: index >= siblings - 1, run: on(() => moveLine(ed, 1)) },
        { label: 'Move to…', run: () => setTimeout(() => sendSelectionPicker([eid]), 120) }
      ],
      [{ label: under ? `Delete line and the ${lines(under)} under it` : 'Delete line', danger: true, run: () => {
        const now = findLine(eid);
        if (!now) return;
        const tr = ed.state.tr;
        // The page always keeps at least one line.
        if (now.$pos.depth === 1 && now.$pos.parent.childCount === 1) tr.replaceWith(now.pos, now.pos + now.node.nodeSize, ed.schema.nodes.listItem.create(null, ed.schema.nodes.paragraph.create()));
        else tr.delete(now.pos, now.pos + now.node.nodeSize);
        ed.view.dispatch(tr);
        ed.commands.focus();
        toast(under ? `Deleted a line and the ${lines(under)} under it` : 'Line deleted', { label: 'Undo', run: () => ed.chain().focus().undo().run() });
      } }]
    ]
  };
}
notebook.editor.view.dom.addEventListener('line-menu', (e) => {
  const { eid, anchor, at } = e.detail;
  const li = anchor.closest('li');
  li?.classList.add('menu-open');
  openHandleMenu({ anchor, at, editor: notebook.editor, build: () => lineMenu(eid), onClose: () => { li?.classList.remove('menu-open'); placeOutlineBar(); } });
});

// On a phone, a standing rule: the caret always sits clear above the keyboard
// and the row, with a line to spare, however it got there (a tap, typing,
// zooming, moving a line, or the keyboard opening). The page only moves when
// the caret would be hidden, and only as far as it must, so typing never
// makes it jump. ProseMirror's own scrolling defers to this on a phone.
for (const ed of [editor, notebook.editor]) {
  ed.view.setProps({ scrollMargin: caretRoom, scrollThreshold: caretRoom, handleScrollToSelection: () => (typewriter() ? holdLine(ed) : touch.matches && keepCaretInView(ed)) });
}
function keepCaretInView(ed = currentEditor()) {
  if (typewriter()) return holdLine(ed);
  if (!touch.matches || !ed?.isFocused) return false;
  let r;
  try { r = ed.view.coordsAtPos(ed.state.selection.head); } catch { return false; }
  const vv = window.visualViewport;
  const bar = [scriptBar, outlineBar].find((b) => !b.hidden);
  const floor = (bar ? bar.getBoundingClientRect().top : vv ? vv.offsetTop + vv.height : window.innerHeight) - ROOM_BELOW;
  const ceiling = (vv ? vv.offsetTop : 0) + ROOM_ABOVE;
  if (r.bottom > floor) window.scrollBy(0, r.bottom - floor);
  else if (r.top < ceiling) window.scrollBy(0, r.top - ceiling);
  return true;
}
// Typewriter mode: the line you're on stays just above the middle of what
// you can see (above the phone's keyboard), and the page glides under it.
const typewriter = () => root.classList.contains('typewriter');
function holdLine(ed = currentEditor()) {
  if (!ed?.isFocused) return false;
  let r;
  try { r = ed.view.coordsAtPos(ed.state.selection.head); } catch { return false; }
  const vv = window.visualViewport;
  const bar = [scriptBar, outlineBar].find((b) => !b.hidden);
  const top = vv ? vv.offsetTop : 0;
  const bottom = bar ? bar.getBoundingClientRect().top : vv ? vv.offsetTop + vv.height : window.innerHeight;
  const delta = r.top - (top + (bottom - top) * 0.45);
  if (Math.abs(delta) > 3) window.scrollBy({ top: delta, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return true;
}
function toggleTypewriter() {
  const on = !typewriter();
  root.classList.toggle('typewriter', on);
  try { localStorage.setItem('typewriter', on ? '1' : '0'); } catch { /* private window */ }
  $('#typewriter-mode').checked = on;
  if (on) requestAnimationFrame(() => holdLine());
  toast(on ? 'Typewriter on: the line you’re on stays put' : 'Typewriter off');
}
let caretTimer;
const caretSoon = (ms = 60) => { clearTimeout(caretTimer); caretTimer = setTimeout(() => requestAnimationFrame(() => keepCaretInView()), ms); };
for (const ed of [editor, notebook.editor]) { ed.on('selectionUpdate', () => caretSoon(typewriter() ? 0 : 60)); ed.on('focus', () => caretSoon(250)); }
window.visualViewport?.addEventListener('resize', () => caretSoon(120));
window.visualViewport?.addEventListener('scroll', () => caretSoon(200));
notebook.editor.on('transaction', placeOutlineBar);
notebook.editor.on('focus', placeOutlineBar);
notebook.editor.on('blur', () => setTimeout(placeOutlineBar, 50));
window.visualViewport?.addEventListener('resize', placeOutlineBar);
window.visualViewport?.addEventListener('scroll', placeOutlineBar);

const currentEditor = () => (inNotebook() ? notebook.editor : editor);

// ---------- getting around ----------

// Where you are, kept per device so the app opens back there.
// Each place also goes in the browser's history, so Back and Forward (mouse
// buttons, Alt+← →, ⌘[ ]) step through where you've been.
let historyMode = 'replace';
function remember(place) {
  try { localStorage.setItem('place', JSON.stringify(place)); } catch { /* full */ }
  if (JSON.stringify(history.state) === JSON.stringify(place)) return;
  if (historyMode === 'push') history.pushState(place, '');
  else history.replaceState(place, '');
}

window.addEventListener('popstate', async (e) => {
  if (!e.state?.view) return;
  historyMode = 'replace';
  try { await go(e.state); } finally { historyMode = 'push'; }
});

async function go(place) {
  // Somewhere that has since gone to the Trash (Back can lead there): go nearby instead.
  if (place.view === 'write' && place.chapterId && gone(await getEntry(place.chapterId))) place = { view: 'library' };
  if (place.view === 'project' && gone(await getEntry(place.id))) place = { view: 'library' };
  // A book saved as a place before worlds: if it became a world, show that.
  if (place.view === 'project' && (await getEntry(place.id))?.kind === 'world') place = { view: 'world', id: place.id };
  if (place.view === 'world' && gone(await getEntry(place.id))) place = { view: 'library' };
  if (place.view === 'grid' && gone(await getEntry(place.id))) place = { view: 'library' };
  if (place.view === 'production' && gone(await getEntry(place.id))) place = { view: 'library' };
  if (place.view === 'compare' && gone(await getEntry(place.id))) place = { view: 'library' };
  // A chapter of a kept draft reads beside the draft you're writing, rather than opening to write in.
  if (place.view === 'write' && place.chapterId) {
    const ch = await getEntry(place.chapterId);
    const kept = ch?.kind === 'chapter' && (await draftHolding(ch));
    if (kept) place = { view: 'compare', id: kept.parent_id, a: { type: 'draft', id: kept.id }, b: { type: 'now' }, focus: ch.id };
  }
  if (place.view === 'notebook' && place.pageId && !place.pageId.startsWith('day-') && gone(await getEntry(place.pageId))) place = { view: 'notebook', pageId: dayId(isoToday()) };
  if (place.view === 'notebook' && !place.pageId && notebook.page && !notebook.isDay && gone(await getEntry(notebook.page.id))) place = { view: 'notebook', pageId: dayId(isoToday()) };
  const from = view();
  // Switch at once so the next keystroke lands in the right place; saving catches up.
  if (from === 'write' && place.view !== 'write') store.close(editor.state.doc);
  // The grid reads the manuscript as saved, so the last words go first.
  if (place.view === 'grid' || place.view === 'production' || place.view === 'compare') await store.close(editor.state.doc);
  if (place.view !== 'write') { if (beside.isOpen) beside.close(); if (talk.isOpen) talk.close(); }
  if (from === 'notebook' && place.view !== 'notebook') notebook.close();
  if (place.view === 'write') delete root.dataset.view;
  else root.dataset.view = place.view;
  body.classList.remove('show-outline');
  $('#view-toggle').textContent = place.view === 'notebook' ? 'Write' : 'Today';

  if (place.view === 'write') {
    editor.commands.focus();
    const id = place.chapterId || state.chapterId || (await lastChapterAnywhere());
    if (!id) return go({ view: 'library' });
    // Back from the grid after it changed things: read the chapter afresh.
    if (gridTouched && id === state.chapterId) state.chapterId = null;
    gridTouched = false;
    if (id !== state.chapterId) await openChapter(id);
    else remember({ view: 'write', chapterId: id });
    if (place.focus) focusParagraph(place.focus);
  } else if (place.view === 'notebook') {
    notebook.editor.commands.focus();
    const id = place.pageId;
    if (id && id !== notebook.page?.id) {
      const fallback = id.startsWith('day-') ? entry('day', { id, title: id.slice(4) }) : null;
      await notebook.open(id, fallback, place.line);
    } else if (!notebook.page) await notebook.openDay();
    else {
      if (place.line) notebook.focusLine(place.line);
      remember({ view: 'notebook', pageId: notebook.page.id });
    }
    if ((place.zoom || null) !== notebook.zoom) {
      const mode = historyMode;
      historyMode = 'replace';
      notebook.zoomTo(place.zoom || null);
      historyMode = mode;
    }
  } else if (place.view === 'library') {
    if ('area' in place) state.libArea = place.area;
    remember({ view: 'library', area: state.libArea });
    await renderLibrary();
  } else if (place.view === 'project') {
    state.bookId = place.id;
    remember(place);
    await renderProject();
  } else if (place.view === 'world') {
    state.worldId = place.id;
    remember(place);
    await renderWorld();
  } else if (place.view === 'tags') {
    remember(place);
    await tagsPage?.show(place);
  } else if (place.view === 'grid') {
    state.gridId = place.id;
    remember(place);
    await grid.show(place.id);
  } else if (place.view === 'production') {
    state.prodId = place.id;
    remember({ view: 'production', id: place.id });
    await production.show(place.id, place);
  } else if (place.view === 'compare') {
    state.compareId = place.id;
    await comparer.show(place.id, place);
    remember(comparer.place);
  }
  renderCrumb();
  renderRail();
}

async function openBook(projectId) {
  const book = await getEntry(projectId);
  if (book && bookType(book) === 'lines') return go({ view: 'notebook', pageId: book.id });
  if (!book || !hasManuscript(book)) return go({ view: 'project', id: projectId });
  const acts = await outline(projectId);
  const chapters = acts.flatMap((a) => a.chapters);
  const last = await getMeta(`lastChapter:${projectId}`);
  const id = chapters.some((c) => c.id === last) ? last : chapters[0]?.id;
  if (id) return go({ view: 'write', chapterId: id });
  return go({ view: 'project', id: projectId });
}

async function lastChapterAnywhere() {
  const last = await getMeta('lastChapter');
  const ch = last && (await getEntry(last));
  if (!gone(ch)) {
    const book = await bookOf(ch);
    if (!gone(book)) return ch.id;
  }
  const novels = (await books()).filter(hasManuscript).sort((a, b) => a.created_at - b.created_at);
  for (const b of novels) {
    const first = (await outline(b.id)).flatMap((a) => a.chapters)[0];
    if (first) return first.id;
  }
  return null;
}

function focusParagraph(eid) {
  editor.state.doc.forEach((node, pos) => {
    if (node.attrs.eid === eid) { editor.commands.setTextSelection(pos + node.nodeSize - 1); editor.view.nodeDOM(pos)?.scrollIntoView({ block: 'center' }); }
  });
}

// Follow a link: pages and days open in the notebook, chapters in the
// manuscript, books on their home page, and a single line or paragraph opens
// where it lives.
async function openEntry(id) {
  const row = await getEntry(id);
  // A link to a day that hasn't been written on yet still opens that day.
  if (!row && id?.startsWith('day-')) return go({ view: 'notebook', pageId: id });
  if (gone(row)) return;
  if (row.kind === 'project') return go({ view: 'project', id: row.id });
  if (row.kind === 'world') return go({ view: 'world', id: row.id });
  if (row.kind === 'area') return go({ view: 'library', area: row.id });
  if (row.kind === 'shootday') return go({ view: 'production', id: row.parent_id, day: row.id });
  if (row.kind === 'shot') { const piece = row.fields?.piece || (await bookOf(row))?.id; if (piece) return go({ view: 'production', id: piece, tab: 'shots', shot: row.id }); }
  const home = await rootOf(row);
  if (!home) return;
  const focus = home.id === row.id ? null : row.id;
  if (home.kind === 'day' || home.kind === 'page') return go({ view: 'notebook', pageId: home.id, line: focus });
  if (home.kind === 'project') return focus ? go({ view: 'notebook', pageId: home.id, line: focus }) : go({ view: 'project', id: home.id });
  if (home.kind === 'chapter') return go({ view: 'write', chapterId: home.id, focus });
}

// A new page goes in the bible of the world you're in (or the piece whose page is open).
async function newPageHere() {
  let parent = null;
  if (view() === 'project') parent = state.bookId;
  else if (view() === 'world') parent = state.worldId;
  else if (view() === 'write') parent = (state.project && (await worldOf(state.project))?.id) || state.project?.id || null;
  else if (inNotebook() && notebook.page && !notebook.isDay) {
    const p = notebook.page;
    const up = p.parent_id ? await getEntry(p.parent_id) : null;
    parent = p.kind === 'project' ? p.id : up && !gone(up) ? up.id : null;
  }
  if (!inNotebook()) await go({ view: 'notebook' });
  await notebook.newPage(parent);
}

// ---------- sync between devices ----------

const syncEl = $('#sync');
const SYNC_LABELS = { 'signed-out': 'Sign in to sync', syncing: 'Syncing…', synced: 'Synced', offline: 'Offline · will sync' };
// Books become worlds once this device has heard from the cloud (or found it
// can't), so the change is made on the newest copy of each book.
let migrated = false;
function migrateOnce() {
  if (migrated) return;
  migrated = true;
  migrateWorlds().catch((e) => console.error(e));
}
const sync = new Sync({
  onStatus: (s) => {
    if (s !== 'syncing') migrateOnce();
    syncEl.hidden = s === 'off';
    syncEl.textContent = SYNC_LABELS[s] || '';
    syncEl.dataset.state = s;
    delete syncEl.dataset.stale;
    document.body.dataset.sync = s;
    if (s === 'synced') { conflicts.count(); checkSpace().catch(() => {}); writeOut(); openAsked(); reviewAsked(); }
    if (s !== 'syncing') checkUnsent().catch(() => {});
  },
  onRemote: applyRemote
});
// Changes that have waited a day or more for the cloud are called out on the
// sync button, and the top bar peeks out once so it's seen.
let warnedUnsent = false;
async function checkUnsent() {
  const state = syncEl.dataset.state;
  if (state === 'syncing' || state === 'off') return;
  const since = await oldestUnsent();
  let label = null;
  if (since && Date.now() - since >= STALE_AFTER && state !== 'synced') label = state === 'signed-out' ? `${unsentLabel(since)} · Sign in` : unsentLabel(since);
  else {
    // Pictures go up after the words, so they can be stuck while the words are synced.
    const files = await unsentFiles();
    if (files.since && Date.now() - files.since >= STALE_AFTER) label = `${unsentFilesLabel(files.count, files.since)}${state === 'signed-out' ? ' · Sign in' : ''}`;
  }
  if (!label) return;
  syncEl.hidden = false;
  syncEl.textContent = label;
  syncEl.dataset.stale = 'true';
  if (!warnedUnsent) {
    warnedUnsent = true;
    body.classList.add('show-top');
    setTimeout(() => { if (!document.querySelector('.topbar:hover')) body.classList.remove('show-top'); }, 6000);
  }
}
// The cloud's file space: a notice once it's 80% full, and again at 95%.
async function checkSpace() {
  const { bytes } = await spaceUsed();
  let warned = 0;
  try { warned = Number(localStorage.getItem('spaceWarned')) || 0; } catch { /* private window */ }
  const w = spaceWarning(bytes, SPACE, warned);
  if (bytes < SPACE * 0.8 && warned) try { localStorage.removeItem('spaceWarned'); } catch { /* ignore */ }
  if (!w) return;
  try { localStorage.setItem('spaceWarned', String(w.level)); } catch { /* ignore */ }
  toast(w.text);
}
setInterval(() => checkUnsent().catch(() => {}), 36e5);

setMoveHooks({
  open: () => [
    { rootId: state.chapterId, editor, store },
    { rootId: notebook.page?.id, editor: notebook.editor, store: notebook.store }
  ],
  refresh: (rows) => applyRemote(rows)
});
const conflicts = new Conflicts({ onApplied: (rows) => applyRemote(rows) });
// Progress keeps a small daily tally; it's noted a little after you stop typing.
let tallyTimer = null;
// It counts everything, so while you keep writing it's noted at most every ten
// minutes (and whenever the app is put away), not after every pause.
let tallyAt = 0;
const tallySoon = (ms = 20000) => {
  clearTimeout(tallyTimer);
  const wait = Math.max(ms, tallyAt + 10 * 60000 - Date.now());
  tallyTimer = setTimeout(() => { tallyAt = Date.now(); recordProgress().catch((e) => console.error(e)); }, wait);
};
onLocalWrites((rows) => {
  sync.soon();
  searchChanged(rows);
  if (rows.some((r) => r.kind !== 'tally')) tallySoon();
  if (rows.some((r) => r.kind === 'file')) checkSpace().catch(() => {});
  retitleLinks(rows).then((changed) => { if (changed) { freshenRefs(editor); freshenRefs(notebook.editor); } }).catch((e) => console.error(e));
});
window.__sync = sync;
window.__notebook = notebook;
window.__vaultFiles = vaultFiles;
syncEl.addEventListener('click', () => { if (syncEl.dataset.state === 'signed-out') sync.signIn(); else sync.soon(0); });

// An untouched starter book on a new device gives way to the real one from the cloud.
async function dropEmptySeed(keep) {
  for (const p of await byKind('project')) {
    if (p.id === keep.id || p.deleted || p.title !== 'Untitled novel') continue;
    const acts = await outline(p.id);
    const chapters = acts.flatMap((a) => a.chapters);
    if (!chapters.every((c) => !c.fields?.words)) continue;
    const now = Date.now();
    const world = p.parent_id ? await getEntry(p.parent_id) : null;
    const wrap = world?.kind === 'world' && world.id === `wd-${p.id}` ? [world] : [];
    await putEntries([p, ...acts, ...chapters, ...wrap].map((e) => ({ ...e, deleted: true, updated_at: now })));
  }
}

// Books from before worlds (or from a device still on an older version) become worlds.
async function migrateWorlds() {
  if (await ensureWorlds()) await refreshViews();
}

async function applyRemote(rows) {
  searchChanged(rows);
  if (view() === 'tags' && tagsPage && rows.some((r) => r.tags?.length || r.id === 'settings-tag-groups')) tagsPage.refresh();
  if (rows.some((r) => r.kind === 'settings')) await notes.reloadTypes();
  if (state.chapterId && rows.some((r) => r.links?.includes(state.chapterId))) renderChapterLinks();
  const structural = rows.some((r) => ['project', 'world', 'act', 'chapter', 'area', 'page', 'draft'].includes(r.kind));
  if (structural) {
    const remoteProject = rows.find((r) => r.kind === 'project' && !r.deleted);
    if (remoteProject) await dropEmptySeed(remoteProject);
    if (migrated && rows.some((r) => r.kind === 'project' && !r.deleted && !r.parent_id)) await ensureWorlds();
    if (state.project) {
      const p = await getEntry(state.project.id);
      state.project = gone(p) ? null : p;
    }
    const ch = state.chapterId && (await getEntry(state.chapterId));
    if (state.chapterId && gone(ch)) await leaveChapter();
    // The other device started a new draft: this chapter is now in the kept one.
    if (view() === 'write' && ch && !gone(ch) && (await draftHolding(ch))) {
      await store.close(editor.state.doc);
      state.chapterId = null;
      const first = state.project && (await outline(state.project.id)).flatMap((a) => a.chapters)[0];
      if (first) await openChapter(first.id);
      toast('A new draft was started on your other device; the earlier one is kept whole');
    }
    if (view() === 'write' && (!state.project || gone(ch))) {
      state.chapterId = null;
      const id = await lastChapterAnywhere();
      if (id) await openChapter(id);
      else await go({ view: 'library' });
    } else if (state.project) state.acts = await outline(state.project.id);
    if (inNotebook() && notebook.page && !notebook.isDay && gone(await getEntry(notebook.page.id))) await go({ view: 'notebook', pageId: dayId(isoToday()) });
    if (view() === 'library') await renderLibrary();
    if (view() === 'project') await renderProject();
    if (view() === 'world') await renderWorld();
    renderRail();
    renderCrumb();
  }
  if (rows.some((r) => r.parent_id === state.chapterId && ['para', 'scene', 'heading'].includes(r.kind))) await applyRemoteChapter();
  if (rows.some((r) => r.kind === 'note' && r.fields?.chapter_id === state.chapterId)) await notes.load(state.chapterId);
  if (view() === 'grid' && rows.some((r) => ['note', 'thread', 'para', 'scene', 'chapter', 'act', 'project', 'world'].includes(r.kind))) grid.refresh();
  if (view() === 'production' && rows.some((r) => ['shot', 'breakdown', 'shootday', 'file', 'page', 'note', 'para', 'scene', 'chapter', 'act', 'project', 'world'].includes(r.kind))) production.refresh();
  await notebook.applyRemote(rows);
  if (inNotebook() && notebook.isDay && rows.some((r) => r.kind === 'review' || r.parent_id === notebook.page.id || r.parent_id === 'pg_mulling')) dayReview?.refresh();
}

let caretAfter = null;
async function applyRemoteChapter(tries = 0) {
  // Never replace text that's still being saved; wait for this device to settle.
  if (!store.idle) { if (tries < 20) setTimeout(() => applyRemoteChapter(tries + 1), 800); return; }
  const doc = await store.refresh();
  if (JSON.stringify(doc) === JSON.stringify(editor.state.doc.toJSON())) return;
  const { $from } = editor.state.selection;
  const block = $from.node(1);
  // Words you talked in land where the caret was: it moves to the end of them.
  const anchor = caretAfter ? { eid: caretAfter, offset: Infinity } : block ? { eid: block.attrs.eid, offset: $from.parentOffset } : null;
  caretAfter = null;
  const focused = editor.isFocused;
  editor.commands.setContent(doc, { emitUpdate: false });
  if (anchor?.eid) {
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs.eid === anchor.eid) {
        const at = Math.min(pos + 1 + anchor.offset, pos + node.nodeSize - 1);
        editor.commands.setTextSelection(at);
      }
    });
  }
  if (focused) editor.view.focus();
  refreshWords();
  scheduleScenes();
  notes.layout();
}

// ---------- chapters ----------

async function openChapter(id) {
  if (state.chapterId === id) return;
  if (state.chapterId) await store.close(editor.state.doc);
  const { doc, recovered } = await store.load(id);
  state.chapterId = id;
  const book = await bookOf(store.chapter);
  if (book && book.id !== state.project?.id) state.project = book;
  root.classList.toggle('script', bookType(book) === 'screenplay');
  root.classList.toggle('numbered', !!book?.fields?.numbered);
  numbering = book?.fields?.numbered ? await numberingAround(book, id) : { before: null, after: null, used: [] };
  requestAnimationFrame(placeScriptBar);
  editor.commands.setContent(doc, { emitUpdate: false });
  if (recovered) store.change(editor.state.doc);
  else statusEl.textContent = 'Saved';
  freshenRefs(editor);
  if (state.project) state.acts = await outline(state.project.id);
  notes.threads = await threadsOf(book && (await worldOf(book)));
  await notes.load(id);
  await renderChapterLinks();
  await setMeta('lastChapter', id);
  if (state.project) await setMeta(`lastChapter:${state.project.id}`, id);
  if (view() === 'write') remember({ view: 'write', chapterId: id });
  if (beside.isOpen) beside.follow(id);
  if (talk.isOpen) talk.open(id);
  refreshWords();
  renderRail();
  renderCrumb();
  editor.commands.focus('end');
}

// Scene numbers already given in a script's other chapters: the last one
// before this chapter, the first after it, and all of them.
async function numberingAround(piece, chapterId) {
  const chapters = (await outline(piece.id)).flatMap((a) => a.chapters);
  const i = chapters.findIndex((c) => c.id === chapterId);
  const codesIn = async (ch) => (await children(ch.id)).filter((r) => r.fields?.el === 'scene' && r.fields?.code).map((r) => r.fields.code);
  const before = [];
  const after = [];
  for (const [j, ch] of chapters.entries()) if (j !== i) (j < i ? before : after).push(...(await codesIn(ch)));
  return { before: before.at(-1) || null, after: after[0] || null, used: [...before, ...after] };
}

// Number a script's scenes, for production. Once on, every scene keeps its
// number for good and new ones slot in (3A); turning it off only hides them.
async function toggleNumbering(piece) {
  const b = await getEntry(piece.id);
  const on = !b.fields?.numbered;
  if (on) {
    const ok = await ask({
      title: `Number the scenes in “${nameOf(b)}”?`,
      body: 'Each scene heading gets a number that never changes, so file names, shot lists and notes keep pointing at the right scene. A scene you add later between 3 and 4 becomes 3A. Do this when the script is heading into production; nothing else about the script changes, and you can hide the numbers any time.',
      ok: 'Number the scenes'
    });
    if (!ok) return;
  }
  const open = state.project?.id === b.id && state.chapterId;
  if (open) await store.close(editor.state.doc);
  const next = { ...b, fields: { ...b.fields, numbered: on }, updated_at: Date.now() };
  const rows = [next];
  if (on) {
    // Every chapter of the script in order, as one run of scenes.
    const scenes = [];
    for (const ch of (await outline(b.id)).flatMap((a) => a.chapters)) scenes.push(...(await children(ch.id)).filter((r) => r.kind === 'para' && r.fields?.el === 'scene' && (r.text || '').trim()));
    const codes = assignCodes(scenes.map((r) => r.fields?.code || null));
    scenes.forEach((r, i) => { if (r.fields?.code !== codes[i]) rows.push({ ...r, fields: { ...r.fields, code: codes[i] }, updated_at: Date.now() }); });
  }
  await putEntries(rows);
  if (state.project?.id === b.id) {
    state.project = next;
    root.classList.toggle('numbered', on);
    if (open) {
      numbering = on ? await numberingAround(next, state.chapterId) : { before: null, after: null, used: [] };
      editor.commands.setContent(await store.refresh(), { emitUpdate: false });
      renderScenes();
    }
  }
  await refreshViews();
  toast(on ? `Scenes numbered in “${nameOf(b)}”` : 'Scene numbers are hidden. They come back as they were if you turn them on again.');
}

// The Inkwell connector: an address that lets Claude, in any Claude chat,
// read Inkwell and add to it (new lines and pages, marked as Claude's). Only a
// fingerprint of it is kept, so it's shown once; making a new one turns the
// old one off.
async function connectClaude() {
  if (!sync.user || !sync.backend?.rpc) { toast('Sign in to sync first: the connector reaches Inkwell through your cloud copy.'); return; }
  const ok = await ask({
    title: 'Connect Claude to Inkwell?',
    body: 'You get an address to add in Claude as a custom connector (Settings, then Connectors, then Add custom connector). Claude can then read your worlds, pages and drafts from any chat, and add lines and pages, marked as written by Claude. It never changes or deletes what you wrote. Anyone with the address can do the same, so keep it private. Making a new address turns off the old one.',
    ok: 'Make my address'
  });
  if (!ok) return;
  let token;
  try { token = await sync.backend.rpc('new_inkwell_mcp_token'); } catch (e) { console.error(e); toast('Couldn’t make an address. Check your connection and try again.'); return; }
  const got = await showCopy({
    title: 'Your Inkwell connector address',
    body: 'It’s only shown this once, so copy it now and paste it into Claude.',
    value: `${sync.backend.functionsUrl}/inkwell-mcp/${token}`,
    extra: { label: 'Turn off Claude’s access', danger: true }
  });
  if (got === 'extra') {
    try { await sync.backend.rpc('revoke_inkwell_mcp_token'); toast('Claude’s access to Inkwell is off'); } catch { toast('Couldn’t turn it off. Try again.'); }
  }
}

// Scribe, the dictation app: Scribe opens Inkwell at ?connect=scribe, and this
// makes a secret for that device and hands it back to the app. Each device
// has its own; connecting the same one again replaces its old secret.
async function connectScribe() {
  const user = sync.user || await sync.backend?.user?.().catch(() => null);
  if (!user || !sync.backend?.rpc) { toast('Sign in to sync first: Scribe connects through your Inkwell account.'); return; }
  const android = /Android/i.test(navigator.userAgent);
  const ok = await ask({
    title: android ? 'Connect Scribe on this phone?' : 'Connect Scribe?',
    body: 'Scribe, your dictation keyboard, can then write out what you say and have Claude tidy it. It only uses your account for that; it can’t read your writing.',
    ok: 'Connect'
  });
  if (!ok) return;
  let token;
  try { token = await sync.backend.rpc('new_scribe_token', { device: android ? 'phone' : 'computer' }); } catch (e) { console.error(e); toast('Couldn’t connect Scribe. Check your connection and try again.'); return; }
  const query = `token=${token}&url=${encodeURIComponent(sync.backend.functionsUrl)}`;
  if (android) {
    // Opening the app needs a tap, so it's its own button.
    const go = await ask({ title: 'Scribe is connected', body: 'Go back to Scribe to finish.', ok: 'Open Scribe' });
    if (go) location.href = `intent://connect?${query}#Intent;scheme=scribe;package=com.laserbunny.scribe;end`;
    return;
  }
  await showCopy({ title: 'Scribe connection link', body: 'Paste this into Scribe on your computer. It’s only shown once.', value: `scribe://connect?${query}` });
}

// What links to this chapter, shown after its last paragraph.
async function renderChapterLinks() {
  if (!state.chapterId) return;
  const n = await renderLinkedFrom(state.chapterId, $('.chapter-links'), $('#chapter-links-list'), openEntry);
  const chip = $('#chapter-links-chip');
  chip.hidden = !n || view() !== 'write';
  chip.textContent = `Linked from ${n}`;
}
$('#chapter-links-chip').addEventListener('click', () => $('.chapter-links').scrollIntoView({ behavior: 'smooth', block: 'center' }));

function refreshWords() {
  if (view() !== 'write') { $('#words').textContent = ''; return; }
  if (isScript()) { const n = scriptPages(editor.state.doc); $('#words').textContent = `About ${n} page${n === 1 ? '' : 's'}`; return; }
  $('#words').textContent = `${wordCount(editor.state.doc.textContent).toLocaleString()} words`;
}

async function newChapter() {
  if (!state.project) return;
  const act = state.acts.find((a) => a.chapters.some((c) => c.id === state.chapterId)) || state.acts.at(-1);
  if (!act) return newAct();
  const level = state.project.fields?.levels?.[1] || 'Chapter';
  const count = state.acts.reduce((n, a) => n + a.chapters.length, 0);
  const ch = entry('chapter', { parent_id: act.id, title: `${level} ${count + 1}`, sort: (act.chapters.at(-1)?.sort || 0) + 1 });
  await putEntries([ch]);
  state.acts = await outline(state.project.id);
  await openChapter(ch.id);
}

async function newAct() {
  if (!state.project) return;
  const level = state.project.fields?.levels?.[0] || 'Act';
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  const act = entry('act', { parent_id: state.project.id, title: `${level} ${names[state.acts.length] || state.acts.length + 1}`, sort: (state.acts.at(-1)?.sort || 0) + 1 });
  const chLevel = state.project.fields?.levels?.[1] || 'Chapter';
  const count = state.acts.reduce((n, a) => n + a.chapters.length, 0);
  const ch = entry('chapter', { parent_id: act.id, title: `${chLevel} ${count + 1}`, sort: 1 });
  await putEntries([act, ch]);
  state.acts = await outline(state.project.id);
  await openChapter(ch.id);
}

// ---------- names you can rename in place ----------

function renameable(el, row, after) {
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    el.contentEditable = 'true';
    el.classList.add('renaming');
    el.focus();
    document.getSelection().selectAllChildren(el);
  });
  const finish = async (save) => {
    if (el.contentEditable !== 'true') return;
    el.contentEditable = 'false';
    el.classList.remove('renaming');
    const title = el.textContent.trim();
    if (save && title && title !== row.title) {
      row.title = title;
      row.updated_at = Date.now();
      await putEntries([row]);
      if (row.id === state.project?.id) state.project.title = title;
      renderCrumb();
      after?.();
    } else {
      el.textContent = row.title;
    }
  };
  el.addEventListener('keydown', (e) => {
    if (el.contentEditable !== 'true') return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  el.addEventListener('blur', () => finish(true));
}

const make = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  if (tag === 'button') el.type = 'button';
  return el;
};
const dot = (color) => { const d = make('span', 'dot'); d.style.background = color; return d; };

async function areaPath(areaId, all) {
  const list = all || (await areas());
  const out = [];
  for (let a = list.find((x) => x.id === areaId), i = 0; a && i < 20; a = list.find((x) => x.id === a.parent_id), i++) out.unshift(a);
  return out;
}

const subtree = (areaId, all) => {
  const ids = new Set([areaId]);
  let grew = true;
  while (grew) { grew = false; for (const a of all) if (a.parent_id && ids.has(a.parent_id) && !ids.has(a.id)) { ids.add(a.id); grew = true; } }
  return ids;
};

// ---------- the library sidebar (left edge) ----------

let railBusy = Promise.resolve();
function renderRail() { railBusy = railBusy.then(drawRail).catch((e) => console.error(e)); return railBusy; }

async function drawRail() {
  const [allAreas, allWorlds, allBooks, loose] = await Promise.all([areas(), worlds(), books(), loosePages()]);
  // Where you are: the piece being written or shown, the world it's in, the page open.
  let piece = null;
  if (view() === 'write') piece = state.project;
  else if (view() === 'project') piece = await getEntry(state.bookId);
  else if (view() === 'grid') { const g = await getEntry(state.gridId); if (g?.kind === 'project') piece = g; }
  else if (inNotebook() && notebook.page && !notebook.isDay) piece = await bookOf(notebook.page);
  let world = null;
  if (view() === 'world') world = await getEntry(state.worldId);
  else if (view() === 'grid' && !piece) world = await getEntry(state.gridId);
  else if (piece) world = await worldOf(piece);
  else if (inNotebook() && notebook.page && !notebook.isDay) world = await worldOf(notebook.page);
  const pageId = inNotebook() ? notebook.page?.id : null;
  // The world you're in, for the commands that act on it.
  state.worldId = world?.id || null;

  const tree = $('#outline-tree');
  const out = [];
  $('.rail-top [data-cmd="library"]').classList.toggle('current', view() === 'library');
  $('.rail-top [data-cmd="today"]').classList.toggle('current', inNotebook() && notebook.page?.id === dayId(isoToday()) );

  const manuscript = async (b, pad) => {
    const acts = b.id === state.project?.id ? state.acts : await outline(b.id);
    for (const act of acts) {
      const a = make('div', 'tree-act', act.title);
      a.style.paddingLeft = `${pad}px`;
      renameable(a, act);
      onContextMenu(a, () => actMenu(act));
      out.push(a);
      for (const ch of act.chapters) {
        const c = make('button', 'tree-chapter' + (ch.id === state.chapterId && view() === 'write' ? ' current' : ''), ch.title);
        c.style.paddingLeft = `${pad + 14}px`;
        c.addEventListener('click', () => { if (c.contentEditable !== 'true') go({ view: 'write', chapterId: ch.id }); });
        renameable(c, ch);
        onContextMenu(c, () => chapterMenu(ch));
        out.push(c);
        if (ch.id === state.chapterId && view() === 'write') {
          const scenes = make('div');
          scenes.id = 'outline-scenes';
          scenes.style.setProperty('--pad', `${pad + 30}px`);
          out.push(scenes);
        }
      }
    }
  };
  const pageNode = (p, pad) => {
    const c = make('button', 'tree-page' + (pageId === p.id ? ' current' : ''), p.title || 'Untitled page');
    c.style.paddingLeft = `${pad}px`;
    c.addEventListener('click', () => go({ view: 'notebook', pageId: p.id }));
    onContextMenu(c, () => pageMenu(p));
    out.push(c);
  };
  // The world you're in opens up: its pieces (the one you're in shows its
  // chapters), then its bible pages, nested.
  const worldNode = async (w, depth) => {
    const area = allAreas.find((a) => a.id === w.area_id);
    const btn = make('button', 'tree-book tree-world' + (w.id === world?.id && view() === 'world' ? ' current' : ''));
    btn.style.paddingLeft = `${10 + depth * 14}px`;
    const name = make('span', 'name', w.title || 'Untitled');
    btn.append(dot(areaColor(area)), name);
    btn.addEventListener('click', () => { if (name.contentEditable !== 'true') go({ view: 'world', id: w.id }); });
    renameable(name, w, renderRail);
    onContextMenu(btn, () => worldMenu(w));
    out.push(btn);
    if (w.id !== world?.id) return;
    const base = 26 + depth * 14;
    const { pieces, pages } = await worldTree(w.id);
    for (const { row: b, depth: d } of pieces) {
      const pad = base + d * 14;
      const pb = make('button', 'tree-page tree-piece' + (b.id === piece?.id && view() !== 'write' ? ' current' : ''), b.title || 'Untitled');
      pb.style.paddingLeft = `${pad}px`;
      pb.addEventListener('click', () => go({ view: 'project', id: b.id }));
      onContextMenu(pb, () => bookMenu(b));
      out.push(pb);
      if (b.id === piece?.id && hasManuscript(b)) await manuscript(b, pad + 12);
      if (b.id === piece?.id) for (const p of await pagesIn(b.id)) pageNode(p, pad + 12);
    }
    for (const { row: p, depth: d } of pages) pageNode(p, base + d * 14);
  };

  const areaNode = async (area, depth) => {
    const label = make('button', 'tree-area', area.title);
    label.style.paddingLeft = `${10 + depth * 14}px`;
    label.addEventListener('click', () => { if (label.contentEditable !== 'true') go({ view: 'library', area: area.id }); });
    renameable(label, area, renderRail);
    onContextMenu(label, () => areaMenu(area));
    out.push(label);
    for (const w of allWorlds.filter((x) => x.area_id === area.id).sort((x, y) => x.title.localeCompare(y.title))) await worldNode(w, depth);
    for (const sub of allAreas.filter((a) => a.parent_id === area.id)) await areaNode(sub, depth + 1);
  };

  for (const area of allAreas.filter((a) => !a.parent_id || !allAreas.some((x) => x.id === a.parent_id))) await areaNode(area, 0);
  const orphans = allWorlds.filter((w) => !allAreas.some((a) => a.id === w.area_id));
  if (orphans.length) { out.push(make('div', 'tree-area', 'Other')); for (const w of orphans) await worldNode(w, 0); }
  // A piece open on its own, outside any world (only while an older device catches up).
  if (piece && !world && allBooks.some((b) => b.id === piece.id)) {
    const pb = make('button', 'tree-page tree-piece current', piece.title || 'Untitled');
    pb.style.paddingLeft = '10px';
    out.push(pb);
    if (hasManuscript(piece)) await manuscript(piece, 24);
  }
  if (loose.length) {
    out.push(make('div', 'tree-area', 'Loose pages'));
    for (const p of loose.slice(0, 12)) pageNode(p, 10);
    if (loose.length > 12) {
      const more = make('button', 'tree-page tree-more', `All ${loose.length} loose pages ›`);
      more.style.paddingLeft = '10px';
      more.addEventListener('click', async () => { await go({ view: 'library', area: null }); $('#lib-loose-box').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      out.push(more);
    }
  }
  tree.replaceChildren(...out);
  renderScenes();

  const tags = await topTags(30);
  $('#shelves-tags').replaceChildren(...tags.map((t) => {
    const b = make('button', 'tag-chip', `#${t}`);
    b.addEventListener('click', () => notebook.showTag(t));
    return b;
  }));
  if (tags.length) {
    const all = make('button', 'tag-chip all-tags', 'All tags…');
    all.addEventListener('click', () => go({ view: 'tags' }));
    $('#shelves-tags').append(all);
  }
  $('#shelves-tags-label').hidden = !tags.length;
}

let scenesTimer;
function scheduleScenes() {
  clearTimeout(scenesTimer);
  scenesTimer = setTimeout(renderScenes, 400);
}

function renderScenes() {
  const box = $('#outline-scenes');
  if (!box) return;
  box.replaceChildren();
  // In a script, sections are your story's own headings, nested (act,
  // sequence, scene…), and the INT./EXT. scene headings sit under them.
  let depth = 0;
  const pad = box.style.getPropertyValue('--pad');
  editor.state.doc.forEach((node, pos) => {
    const slug = isScript() && node.type.name === 'paragraph' && node.attrs.el === 'scene' && node.textContent.trim();
    if (node.type.name !== 'sceneBreak' && !slug) return;
    const level = node.type.name === 'sceneBreak' ? node.attrs.level || 1 : 0;
    if (level) depth = level;
    const code = slug && root.classList.contains('numbered') && node.attrs.code ? `${node.attrs.code}  ` : '';
    const b = make('button', slug ? 'tree-scene tree-slug' : 'tree-scene', slug ? code + slug.toUpperCase() : node.attrs.title || (isScript() ? `Untitled ${sectionName(level, sectionNames()).toLowerCase()}` : 'Untitled scene'));
    if (level) b.dataset.level = level;
    b.style.paddingLeft = `calc(${pad} + ${(slug ? depth : level - 1) * 12}px)`;
    b.addEventListener('click', () => {
      editor.view.nodeDOM(pos)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editor.commands.focus(pos + node.nodeSize + 1);
    });
    box.append(b);
  });
}

// ---------- breadcrumb: where you are ----------

let crumbBusy = Promise.resolve();
function renderCrumb() { crumbBusy = crumbBusy.then(drawCrumb).catch((e) => console.error(e)); return crumbBusy; }

async function drawCrumb() {
  const parts = [];
  const link = (label, run, cls = '') => { const b = make('button', 'crumb-part ' + cls, label); b.addEventListener('click', run); return b; };
  const all = await areas();
  const lib = link('Library', () => go({ view: 'library', area: null }));
  const areaParts = async (areaId) => (await areaPath(areaId, all)).map((a) => link(a.title, () => go({ view: 'library', area: a.id })));
  const bookPart = (b) => link(`${b.title || 'Untitled'} ▾`, () => openPalette('go', 'books'), 'book');
  // Library › areas › world › pieces and pages it sits in. A world with one
  // piece of the same name shows once.
  const within = async (row) => {
    const chain = [];
    let w = null;
    for (let r = row.parent_id && (await getEntry(row.parent_id)), i = 0; r && i < 40; r = r.parent_id && (await getEntry(r.parent_id)), i++) {
      if (r.kind === 'world') { w = r; break; }
      if (r.kind === 'project' || r.kind === 'page') chain.unshift(r);
    }
    if (!w) return null;
    const out = [lib, ...(await areaParts(w.area_id)), link(w.title || 'Untitled', () => go({ view: 'world', id: w.id }), 'book')];
    for (const r of chain) out.push(link(r.title || 'Untitled', () => (r.kind === 'page' ? go({ view: 'notebook', pageId: r.id }) : go({ view: 'project', id: r.id }))));
    return { out, world: w };
  };
  if (view() === 'library') {
    parts.push(lib, ...(state.libArea ? await areaParts(state.libArea) : []));
  } else if (view() === 'world') {
    const w = await getEntry(state.worldId);
    if (w) parts.push(lib, ...(await areaParts(w.area_id)), bookPart(w));
  } else if (view() === 'grid') {
    const g = await getEntry(state.gridId);
    if (g?.kind === 'world') parts.push(lib, ...(await areaParts(g.area_id)), bookPart(g));
    else if (g) { const up = await within(g); parts.push(...(up ? up.out : [lib]), bookPart(g)); }
    parts.push(link('Plot grid', () => {}, 'here'));
  } else if (view() === 'production') {
    const g = await getEntry(state.prodId);
    if (g) { const up = await within(g); parts.push(...(up ? up.out : [lib]), bookPart(g)); }
    parts.push(link('Production', () => {}, 'here'));
  } else if (view() === 'compare') {
    const g = await getEntry(state.compareId);
    if (g) { const up = await within(g); parts.push(...(up ? up.out : [lib]), bookPart(g)); }
    parts.push(link('Compare', () => {}, 'here'));
  } else if (view() === 'project') {
    const b = await getEntry(state.bookId);
    const up = b && (await within(b));
    if (b) parts.push(...(up ? up.out : [lib, ...(await areaParts(b.area_id))]), bookPart(b));
  } else if (view() === 'write' && state.project) {
    const ch = state.chapterId && (await getEntry(state.chapterId));
    const up = await within(state.project);
    if (up) parts.push(...up.out);
    else parts.push(lib, ...(await areaParts(state.project.area_id)));
    // A novel that is its world's only piece doesn't need saying twice.
    const same = up && state.project.parent_id === up.world.id && (state.project.title || '') === (up.world.title || '');
    // The book you're writing in is a switcher: it lists every world and piece.
    if (same) parts.pop();
    parts.push(bookPart(state.project), link(ch?.title || '', () => {}, 'here'));
  } else if (view() === 'tags') {
    const at = tagsPage?.place || {};
    parts.push(lib, link('Tags', () => go({ view: 'tags' }), at.tag ? '' : 'here'));
    if (at.tag) parts.push(link(`#${at.tag}`, () => go({ view: 'tags', tag: at.tag }), at.walk == null ? 'here' : ''));
  } else if (inNotebook() && notebook.page) {
    const p = notebook.page;
    if (p.kind === 'day') parts.push(link('Daily pages', () => go({ view: 'notebook', pageId: dayId(isoToday()) })), link(titleOf(p), () => {}, 'here'));
    else {
      const up = await within(p);
      if (up) parts.push(...up.out);
      else parts.push(lib, link('Loose pages', () => go({ view: 'library', area: null })));
      parts.push(link(p.title || 'Untitled page', () => {}, 'here'));
    }
  }
  const crumb = $('#crumb');
  crumb.replaceChildren();
  parts.forEach((p, i) => { if (i) crumb.append(make('span', 'sep', '›')); crumb.append(p); });
  refreshWords();
}

// ---------- tidying up: rename, move, change kind, the Trash ----------

const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
const nameOf = (row) => (row.kind === 'day' ? titleOf(row) : row.title || (row.kind === 'page' ? 'Untitled page' : 'Untitled'));
const KINDS = FORMATS;

async function refreshViews() {
  if (state.project) {
    const p = await getEntry(state.project.id);
    state.project = gone(p) ? null : p;
    if (state.project) state.acts = await outline(state.project.id);
  }
  if (view() === 'library') await renderLibrary();
  if (view() === 'project') await renderProject();
  if (view() === 'world') await renderWorld();
  if (inNotebook() && notebook.page && !notebook.isDay) {
    const p = await getEntry(notebook.page.id);
    if (p && !gone(p)) { notebook.page = notebook.store.page = p; notebook.renderHead(); }
  }
  renderRail();
  renderCrumb();
}

// The chapter on screen has gone (here or on another device): finish saving,
// then let it go, so nothing typed later is saved into it.
async function leaveChapter() {
  await store.close(editor.state.doc);
  store.detach();
  state.chapterId = null;
  editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false });
  await notes.load(null);
}

// Is `id` the entry `root` or somewhere inside it (by parent, or a book in an area)?
async function isWithin(id, root) {
  let r = id && (await getEntry(id));
  for (let i = 0; r && i < 80; i++) {
    if (r.id === root.id) return true;
    const up = r.parent_id || (['project', 'world'].includes(r.kind) ? r.area_id : null);
    r = up ? await getEntry(up) : null;
  }
  return false;
}

async function rename(row) {
  const title = await askText({ title: `Rename ${row.kind === 'project' ? kindName(row).toLowerCase() : row.kind}`, value: row.title || '' });
  if (!title) return;
  const fresh = await getEntry(row.id);
  await putEntries([{ ...fresh, title, updated_at: Date.now() }]);
  await refreshViews();
}

// Put something in the Trash. Anything holding writing asks first; everything
// can be brought back (Undo right away, or from the Trash in the Library).
async function toTrash(row) {
  const c = await contents(row);
  const held = [
    c.worlds && plural(c.worlds, 'world'),
    c.books && plural(c.books, 'piece'),
    c.areas && plural(c.areas, 'smaller area'),
    c.chapters && row.kind !== 'chapter' && plural(c.chapters, 'chapter'),
    c.words && plural(c.words, 'word'),
    c.pages && plural(c.pages, 'page'),
    !c.words && c.written && plural(c.written, 'written line')
  ].filter(Boolean);
  const name = nameOf(row);
  // A world whose pieces are still empty goes without asking (Undo is right there).
  if (c.words || c.worlds || c.areas || c.written > 3 || (c.books && row.kind !== 'world')) {
    const ok = await ask({
      title: `Move “${name}” to the Trash?`,
      body: `It holds ${held.join(', ')}. Nothing is deleted: you can bring it all back from the Trash at the bottom of the Library.`,
      ok: 'Move to Trash', danger: true
    });
    if (!ok) return;
  }
  // Step out of it first and finish saving, so nothing still open writes over it.
  const here = view() === 'write' ? state.chapterId : view() === 'project' ? state.bookId : view() === 'world' ? state.worldId : inNotebook() ? notebook.page?.id : null;
  const leaving = !!here && (await isWithin(here, row));
  let away = null;
  if (leaving) {
    if (view() === 'write') {
      await leaveChapter();
      away = state.project && !(await isWithin(state.project.id, row)) ? { view: 'project', id: state.project.id } : { view: 'library' };
    } else if (view() === 'project' || view() === 'world') {
      const w = view() === 'project' ? await worldOf(await getEntry(state.bookId)) : null;
      away = w && !(await isWithin(w.id, row)) ? { view: 'world', id: w.id } : { view: 'library' };
    } else {
      await notebook.close();
      const w = await worldOf(notebook.page);
      away = w && !(await isWithin(w.id, row)) ? { view: 'world', id: w.id } : { view: 'notebook', pageId: dayId(isoToday()) };
    }
  } else if (state.chapterId && (await isWithin(state.chapterId, row))) await leaveChapter();
  await trash(row);
  if (away) await go(away);
  await refreshViews();
  toast(`“${name}” is in the Trash`, { label: 'Undo', run: async () => { await restore(row.id); await refreshViews(); toast(`“${name}” is back`); } });
}

async function setKind(book, type) {
  const b = await getEntry(book.id);
  if (bookType(b) === type) return;
  const s = await stats(b);
  if (hasManuscript(b) && !['novel', 'screenplay'].includes(type) && s.words) {
    const ok = await ask({
      title: `Write “${nameOf(b)}” as ${type === 'lines' ? 'an outline' : 'pages'}?`,
      body: `Its manuscript (${plural(s.words, 'word')}) stays exactly as it is and is still listed on its page. Change it back any time.`,
      ok: 'Change it'
    });
    if (!ok) return;
  }
  const next = await changeType(b, type);
  if (state.project?.id === b.id) {
    state.project = next;
    if (view() === 'write') { root.classList.toggle('script', type === 'screenplay'); placeScriptBar(); refreshWords(); }
  }
  await refreshViews();
  toast(`“${nameOf(b)}” is now written as ${formatName(next).toLowerCase()}`, { label: 'Undo', run: async () => { await changeType(await getEntry(b.id), bookType(b)); if (state.project?.id === b.id) { state.project = await getEntry(b.id); if (view() === 'write') root.classList.toggle('script', bookType(b) === 'screenplay'); } await refreshViews(); } });
}

async function moveBookToArea(book, areaId) {
  const b = await getEntry(book.id);
  await putEntries([{ ...b, area_id: areaId, updated_at: Date.now() }]);
  await refreshViews();
}

// A piece moves to another world, or into another piece (an episode into its season).
async function movePiece(piece, parentId) {
  const p = await getEntry(piece.id);
  if (p.parent_id === parentId || p.id === parentId) return;
  const target = await getEntry(parentId);
  if (!target || (await isWithin(parentId, p))) return;
  const w = target.kind === 'world' ? target : await worldOf(target);
  const sort = ((await piecesIn(parentId)).at(-1)?.sort || 0) + 1;
  await putEntries([{ ...p, parent_id: parentId, area_id: w?.area_id ?? p.area_id, sort, updated_at: Date.now() }]);
  await refreshViews();
  toast(`Moved to ${nameOf(target)}`, { label: 'Undo', run: async () => { await putEntries([{ ...(await getEntry(p.id)), parent_id: p.parent_id, area_id: p.area_id, sort: p.sort, updated_at: Date.now() }]); await refreshViews(); } });
}

// Where a piece or page can go: every world, and the pieces or pages inside them.
async function homesFor(row) {
  const out = [];
  for (const w of (await worlds()).sort((a, b) => (a.title || '').localeCompare(b.title || ''))) {
    out.push({ id: w.id, label: w.title || 'Untitled', depth: 0 });
    const { pieces, pages } = await worldTree(w.id);
    const list = row.kind === 'project' ? pieces : pages;
    for (const { row: r, depth } of list) out.push({ id: r.id, label: r.title || 'Untitled', depth: depth + 1 });
  }
  const mine = new Set();
  for (const h of out) if (h.id === row.id || (await isWithin(h.id, row))) mine.add(h.id);
  return out.filter((h) => !mine.has(h.id)).map((h) => ({ ...h, label: `${'  '.repeat(h.depth)}${h.label}` }));
}

async function movePage(page, parentId) {
  const p = await getEntry(page.id);
  if ((p.parent_id || null) === (parentId || null)) return;
  if (parentId && (parentId === p.id || (await isWithin(parentId, p)))) return;
  const sort = parentId ? (await pagesIn(parentId)).length + 1 : 0;
  await putEntries([{ ...p, parent_id: parentId || null, sort, updated_at: Date.now() }]);
  await refreshViews();
  const to = parentId ? nameOf(await getEntry(parentId)) : 'Loose pages';
  toast(`Moved to ${to}`, { label: 'Undo', run: async () => { await putEntries([{ ...(await getEntry(p.id)), parent_id: p.parent_id, sort: p.sort, updated_at: Date.now() }]); await refreshViews(); } });
}

// Renumber a list in order, writing only what changed.
async function reorder(list, extra = {}) {
  const now = Date.now();
  const rows = list.map((r, i) => ({ r, sort: i + 1 })).filter(({ r, sort }) => r.sort !== sort || Object.entries(extra[r.id] || {}).some(([k, v]) => r[k] !== v))
    .map(({ r, sort }) => { const { chapters: _c, ...row } = r; return { ...row, ...(extra[r.id] || {}), sort, updated_at: now }; });
  await putEntries(rows);
}

// A chapter one step up or down; past the end of its act it moves into the next one.
async function moveChapter(ch, dir) {
  const book = await bookOf(ch);
  const acts = await outline(book.id);
  const ai = acts.findIndex((a) => a.chapters.some((c) => c.id === ch.id));
  const list = acts[ai].chapters;
  const i = list.findIndex((c) => c.id === ch.id);
  const j = i + dir;
  if (j >= 0 && j < list.length) {
    [list[i], list[j]] = [list[j], list[i]];
    await reorder(list);
  } else {
    const to = acts[ai + dir];
    if (!to) return;
    list.splice(i, 1);
    if (dir < 0) to.chapters.push(ch); else to.chapters.unshift(ch);
    await reorder(list);
    await reorder(to.chapters, { [ch.id]: { parent_id: to.id } });
  }
  await refreshViews();
}

async function moveChapterToAct(ch, act) {
  const fresh = await getEntry(act.id);
  const there = await children(fresh.id);
  await putEntries([{ ...(await getEntry(ch.id)), parent_id: act.id, sort: (there.at(-1)?.sort || 0) + 1, updated_at: Date.now() }]);
  await refreshViews();
}

async function moveAct(act, dir) {
  const book = await bookOf(act);
  const acts = await outline(book.id);
  const i = acts.findIndex((a) => a.id === act.id);
  const j = i + dir;
  if (j < 0 || j >= acts.length) return;
  [acts[i], acts[j]] = [acts[j], acts[i]];
  await reorder(acts);
  await refreshViews();
}

async function moveArea(area, parentId) {
  await putEntries([{ ...(await getEntry(area.id)), parent_id: parentId, updated_at: Date.now() }]);
  await refreshViews();
}

// The menus. Each is built when opened, so it always reflects what's there now.
// A piece's menu.
async function bookMenu(book) {
  const b = await getEntry(book.id);
  const writable = hasManuscript(b) || bookType(b) === 'lines';
  const script = bookType(b) === 'screenplay';
  return [
    { label: writable ? (bookType(b) === 'lines' ? 'Open the outline' : 'Open the manuscript') : 'Open', run: () => (writable ? openBook(b.id) : go({ view: 'project', id: b.id })) },
    ...(view() !== 'project' || state.bookId !== b.id ? [{ label: 'Its page', run: () => go({ view: 'project', id: b.id }) }] : []),
    { label: 'Rename…', run: () => rename(b) },
    { label: 'What it is (Gag, Episode…)…', run: () => setLabel(b) },
    { label: 'Written as', sub: KINDS.map(([id, label]) => ({ label, current: bookType(b) === id, run: () => setKind(b, id) })) },
    { label: 'Stage', sub: STAGES.map((st) => ({ label: st, current: stageOf(b) === st, run: () => setStage(b, st) })) },
    ...(script ? [{ label: b.fields?.numbered ? 'Scene numbers: turn off' : 'Number the scenes (for production)…', run: () => toggleNumbering(b) }] : []),
    ...(hasManuscript(b) ? [{ label: 'Production (shots, kit, shoot days)', run: () => go({ view: 'production', id: b.id }) }] : []),
    ...(hasManuscript(b) ? [{ label: 'Revise', sub: [
      { label: 'Compare drafts or dates', run: () => go({ view: 'compare', id: b.id }) },
      { label: 'Start a new draft from scratch…', run: () => newDraft(b) },
      { label: 'Print, or save as PDF', run: async () => { await go({ view: 'project', id: b.id }); await printCurrent(); } }
    ] }] : []),
    ...(hasManuscript(b) ? [{ label: 'Share a link to read and comment…', run: () => openShare(b) }] : []),
    { label: 'New piece inside (an episode in a season…)', run: () => addPiece(b.id) },
    { label: 'New page in it', run: async () => { await go({ view: 'notebook' }); await notebook.newPage(b.id); } },
    { label: 'Move to', sub: (await homesFor(b)).map((h) => ({ label: h.label, current: b.parent_id === h.id, run: () => movePiece(b, h.id) })) },
    'sep',
    { label: 'Move to Trash…', danger: true, run: () => toTrash(b) }
  ];
}

async function worldMenu(world) {
  const w = await getEntry(world.id);
  const all = await areas();
  return [
    ...(view() !== 'world' || state.worldId !== w.id ? [{ label: 'Open', run: () => go({ view: 'world', id: w.id }) }] : []),
    { label: 'Rename…', run: () => rename(w) },
    { label: 'New piece…', run: () => addPiece(w.id) },
    { label: 'New page in its bible', run: async () => { await go({ view: 'notebook' }); await notebook.newPage(w.id); } },
    { label: 'Move to area', sub: (await areaOptions(all)).map(([id, label]) => ({ label: label.trim(), current: w.area_id === id, run: () => moveBookToArea(w, id) })) },
    ...(view() === 'library' ? [
      { label: 'Move earlier in my order', run: () => nudgeBook(w, -1) },
      { label: 'Move later in my order', run: () => nudgeBook(w, 1) }
    ] : []),
    'sep',
    { label: 'Move to Trash…', danger: true, run: () => toTrash(w) }
  ];
}

async function pageMenu(page) {
  const p = await getEntry(page.id);
  return [
    { label: 'Open', run: () => go({ view: 'notebook', pageId: p.id }) },
    { label: 'Rename…', run: () => rename(p) },
    { label: 'New page inside', run: async () => { await go({ view: 'notebook' }); await notebook.newPage(p.id); } },
    { label: 'History…', run: async () => { await go({ view: 'notebook', pageId: p.id }); await openHistory(); } },
    { label: 'Share a link to read and comment…', run: () => openShare(p) },
    { label: 'Move to', sub: [{ label: 'Loose pages (no world)', current: !p.parent_id, run: () => movePage(p, null) }, ...(await homesFor(p)).map((h) => ({ label: h.label, current: p.parent_id === h.id, run: () => movePage(p, h.id) }))] },
    'sep',
    { label: 'Move to Trash', danger: true, run: () => toTrash(p) }
  ];
}

// What a piece is, in your own words; labels you've used before are offered.
async function setLabel(piece) {
  const b = await getEntry(piece.id);
  const label = await askText({ title: 'What is it?', body: `For example ${(await usedLabels()).slice(0, 6).join(', ')}.`, value: kindName(b), ok: 'Save', list: await usedLabels() });
  if (label === null || label === undefined) return;
  const fields = { ...b.fields };
  if (label.trim() && label.trim() !== defaultLabel(bookType(b))) fields.label = label.trim(); else delete fields.label;
  await putEntries([{ ...b, fields, updated_at: Date.now() }]);
  await refreshViews();
}

async function setStage(piece, stage) {
  const b = await getEntry(piece.id);
  await putEntries([{ ...b, fields: { ...b.fields, stage }, updated_at: Date.now() }]);
  await refreshViews();
}

// A new piece in a world or inside a piece: its name, what it is, how it's written.
async function addPiece(parentId) {
  const parent = await getEntry(parentId);
  const got = await askPiece({
    title: `New piece in ${nameOf(parent)}`,
    labels: await usedLabels(),
    formats: [['screenplay', 'Script', 'A short, an episode, a film'], ['novel', 'Prose', 'A novel, a story'], ['lines', 'Outline', 'A gag, a season, loose lines']]
  });
  if (!got) return;
  const label = got.label && got.label !== defaultLabel(got.type) ? got.label : undefined;
  const piece = await newPiece(parentId, got.type, got.title, null, label);
  await refreshViews();
  await go({ view: 'project', id: piece.id });
}

async function chapterMenu(chapter) {
  const ch = await getEntry(chapter.id);
  const book = await bookOf(ch);
  const acts = book ? await outline(book.id) : [];
  const level = book?.fields?.levels?.[0] || 'Act';
  return [
    { label: 'Open', run: () => go({ view: 'write', chapterId: ch.id }) },
    { label: 'Rename…', run: () => rename(ch) },
    { label: 'History…', run: async () => { await go({ view: 'write', chapterId: ch.id }); await openHistory(); } },
    { label: 'Move up', run: () => moveChapter(ch, -1) },
    { label: 'Move down', run: () => moveChapter(ch, 1) },
    ...(acts.length > 1 ? [{ label: `Move to ${level.toLowerCase()}`, sub: acts.map((a) => ({ label: a.title, current: a.id === ch.parent_id, run: () => moveChapterToAct(ch, a) })) }] : []),
    'sep',
    { label: 'Move to Trash…', danger: true, run: () => toTrash(ch) }
  ];
}

async function actMenu(act) {
  const a = await getEntry(act.id);
  const book = await bookOf(a);
  const chLevel = book?.fields?.levels?.[1] || 'Chapter';
  return [
    { label: 'Rename…', run: () => rename(a) },
    { label: `New ${chLevel.toLowerCase()} in it`, run: async () => {
      const there = await children(a.id);
      const count = (await outline(book.id)).reduce((n, x) => n + x.chapters.length, 0);
      const ch = entry('chapter', { parent_id: a.id, title: `${chLevel} ${count + 1}`, sort: (there.at(-1)?.sort || 0) + 1 });
      await putEntries([ch]);
      await go({ view: 'write', chapterId: ch.id });
    } },
    { label: 'Move up', run: () => moveAct(a, -1) },
    { label: 'Move down', run: () => moveAct(a, 1) },
    'sep',
    { label: 'Move to Trash…', danger: true, run: () => toTrash(a) }
  ];
}

async function areaMenu(area) {
  const a = await getEntry(area.id);
  const all = await areas();
  const mine = subtree(a.id, all);
  return [
    { label: 'Open', run: () => go({ view: 'library', area: a.id }) },
    { label: 'Rename…', run: () => rename(a) },
    { label: 'New area inside', run: async () => { const t = await askText({ title: `New area inside ${a.title}`, ok: 'Add' }); if (t) { const n = await newArea(t, a.id); await go({ view: 'library', area: n.id }); } } },
    { label: 'Move inside', sub: [{ label: 'Top level', current: !a.parent_id, run: () => moveArea(a, null) }, ...(await areaOptions(all)).filter(([id]) => !mine.has(id)).map(([id, label]) => ({ label: label.trim(), current: a.parent_id === id, run: () => moveArea(a, id) }))] },
    'sep',
    { label: 'Move to Trash…', danger: true, run: () => toTrash(a) }
  ];
}

// The Trash, at the bottom of the Library.
async function renderTrash() {
  const rows = await trashed();
  const box = $('#lib-trash-box');
  box.hidden = !rows.length;
  $('#lib-trash-count').textContent = rows.length ? `(${rows.length})` : '';
  const what = (r) => (r.kind === 'project' ? kindName(r) : { world: 'World', area: 'Area', act: 'Act', chapter: 'Chapter', page: 'Page' }[r.kind] || 'Item');
  $('#lib-trash').replaceChildren(...rows.map((r) => {
    const li = make('li');
    const back = make('button', 'ghost-btn', 'Restore');
    back.addEventListener('click', async () => { await restore(r.id); await refreshViews(); toast(`“${nameOf(r)}” is back`); });
    const forever = make('button', 'ghost-btn danger', 'Delete forever');
    forever.addEventListener('click', async () => {
      const c = await contents(r);
      const ok = await ask({
        title: `Delete “${nameOf(r)}” forever?`,
        body: `This ${what(r).toLowerCase()}${c.words ? ` and its ${plural(c.words, 'word')}` : ''} will be gone from every device and can’t be brought back.`,
        ok: 'Delete forever', danger: true
      });
      if (!ok) return;
      await deleteForever(r.id);
      await refreshViews();
    });
    li.append(make('span', 'loose-title', nameOf(r)), make('span', 'when', `${what(r)} · trashed ${ago(r.fields.trashed)}`), back, forever);
    return li;
  }));
}

// ---------- library view ----------

// How books are ordered in the Library, per device.
const libSort = () => { try { return localStorage.getItem('libSort') || 'recent'; } catch { return 'recent'; } };
// Your own order: a number on each book (synced, so it's the same on every
// device). Books never placed yet follow, most recently edited first.
const ORDER_KEY = (b) => b.fields?.order ?? Infinity;
const byMyOrder = (a, b) => ORDER_KEY(a) - ORDER_KEY(b) || editedAt(b) - editedAt(a);

// Put a world just before (or after) another one in your order.
async function placeBook(bookId, targetId, after = false) {
  if (bookId === targetId) return;
  const list = (await worlds()).sort(byMyOrder);
  const moving = list.find((b) => b.id === bookId);
  const rest = list.filter((b) => b.id !== bookId);
  const at = rest.findIndex((b) => b.id === targetId);
  if (!moving || at < 0) return;
  rest.splice(after ? at + 1 : at, 0, moving);
  const now = Date.now();
  await putEntries(rest.map((b, i) => ({ b, i })).filter(({ b, i }) => b.fields?.order !== i + 1)
    .map(({ b, i }) => ({ ...b, fields: { ...b.fields, order: i + 1 }, updated_at: now })));
  if (libSort() !== 'custom') { try { localStorage.setItem('libSort', 'custom'); } catch { /* full */ } }
  await refreshViews();
}

// One step earlier or later among the books shown right now.
async function nudgeBook(book, dir) {
  const shown = [...document.querySelectorAll('#lib-books .card-wrap[data-id]')].map((w) => w.dataset.id);
  const list = shown.length && shown.includes(book.id) && libSort() === 'custom' ? shown : (await worlds()).sort(byMyOrder).map((b) => b.id);
  const i = list.indexOf(book.id);
  const target = list[i + dir];
  if (target) await placeBook(book.id, target, dir > 0);
}

async function renderLibrary() {
  const [allAreas, allBooks, loose] = await Promise.all([areas(), worlds(), loosePages()]);
  if (state.libArea && !allAreas.some((a) => a.id === state.libArea)) state.libArea = null;
  const sel = state.libArea;
  const path = sel ? await areaPath(sel, allAreas) : [];

  // Area chips: the top level, then each level down to the one picked.
  const chips = $('#lib-areas');
  chips.replaceChildren();
  const chip = (label, on, run) => { const b = make('button', 'chip' + (on ? ' on' : ''), label); b.addEventListener('click', run); return b; };
  const row = (parentId) => {
    const wrap = make('div', 'chip-row');
    const list = allAreas.filter((a) => (a.parent_id || null) === parentId);
    if (!parentId) wrap.append(chip('All', !sel, () => go({ view: 'library', area: null })));
    for (const a of list) {
      const c = chip(a.title, path.some((p) => p.id === a.id), () => { if (c.contentEditable !== 'true') go({ view: 'library', area: a.id }); });
      renameable(c, a, () => { renderRail(); });
      onContextMenu(c, () => areaMenu(a));
      wrap.append(c);
    }
    wrap.append(addAreaChip(parentId));
    return wrap;
  };
  chips.append(row(null));
  for (const a of path) chips.append(row(a.id));
  const libPath = $('#lib-path');
  libPath.replaceChildren();
  if (sel) {
    const here = allAreas.find((a) => a.id === sel);
    libPath.append(make('span', '', `${here.title}: `), menuButton(() => areaMenu(here), `More for ${here.title}`), make('span', '', ' rename, move or remove this area. + adds an area inside the one you picked.'));
  }

  // Books in the picked area and everything nested under it.
  const ids = sel ? subtree(sel, allAreas) : null;
  const sort = libSort();
  const info = new Map();
  for (const w of allBooks) if (!ids || ids.has(w.area_id)) info.set(w.id, await worldStats(w));
  const recent = (w) => info.get(w.id)?.edited || w.updated_at;
  const shown = allBooks.filter((b) => !ids || ids.has(b.area_id))
    .sort(sort === 'custom' ? byMyOrder : sort === 'title' ? (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }) : sort === 'made' ? (a, b) => b.created_at - a.created_at : (a, b) => recent(b) - recent(a));
  const sortSel = $('#lib-sort');
  sortSel.value = sort;
  sortSel.onchange = () => { try { localStorage.setItem('libSort', sortSel.value); } catch { /* full */ } renderLibrary(); };
  const cards = [];
  for (const b of shown) {
    const area = allAreas.find((a) => a.id === b.area_id);
    const s = info.get(b.id);
    const card = make('button', 'card');
    const kind = make('span', 'card-kind');
    // A world says what's in it: its one piece, how many pieces, or just pages.
    const top = s.pieces.filter((p) => p.depth === 0).map((p) => p.row);
    const what = top.length === 1 && !s.pieces.slice(1).length ? kindName(top[0]).toLowerCase() : s.pieces.length ? 'world' : 'pages';
    kind.append(dot(areaColor(area)), document.createTextNode(`${area?.title || 'No area'} · ${what}`));
    const n = (x, word) => `${x} ${word}${x === 1 ? '' : 's'}`;
    const detail = [
      s.pieces.length > 1 && n(s.pieces.length, 'piece'),
      s.chapters.length > 1 && n(s.chapters.length, 'chapter'),
      s.words && `${s.words.toLocaleString()} words`,
      s.pages.length && n(s.pages.length, 'page')
    ].filter(Boolean).join(' · ') || 'Empty so far';
    card.append(kind, make('span', 'card-title', b.title || 'Untitled'), make('span', 'card-detail', detail), make('span', 'card-when', `Edited ${ago(s.edited)}`));
    card.addEventListener('click', () => go({ view: 'world', id: b.id }));
    onContextMenu(card, () => worldMenu(b));
    const wrap = make('div', 'card-wrap');
    wrap.dataset.id = b.id;
    wrap.append(card, menuButton(() => worldMenu(b), `More for ${b.title || 'this world'}`));
    // In your own order, drag a card onto another to put it there.
    if (sort === 'custom') {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-book', b.id); e.dataTransfer.effectAllowed = 'move'; wrap.classList.add('dragging'); });
      card.addEventListener('dragend', () => wrap.classList.remove('dragging'));
      wrap.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/x-book')) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        wrap.classList.toggle('drop-before', !after);
        wrap.classList.toggle('drop-after', after);
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-before', 'drop-after'));
      wrap.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = wrap.classList.contains('drop-after');
        wrap.classList.remove('drop-before', 'drop-after');
        const id = e.dataTransfer.getData('text/x-book');
        if (id) placeBook(id, b.id, after);
      });
    }
    cards.push(wrap);
  }
  const add = make('button', 'card card-new');
  add.append(make('span', 'plus', '+'), make('span', '', 'New world: a novel, a show, a film, or notes'));
  add.addEventListener('click', () => showNewBook('novel'));
  cards.push(add);
  $('#lib-books').replaceChildren(...cards);

  // Area choices for the new-book form.
  const opts = await areaOptions(allAreas);
  $('#lib-new-area').replaceChildren(...opts.map(([id, label]) => { const o = make('option', '', label); o.value = id; return o; }));
  $('#lib-new-area').value = sel || allAreas[0]?.id || '';

  // Loose pages, each with somewhere to move it.
  const bookOpts = allBooks.slice().sort((a, b) => a.title.localeCompare(b.title));
  $('#lib-loose').replaceChildren(...loose.map((p) => {
    const li = make('li');
    const open = make('button', 'loose-title', p.title || 'Untitled page');
    open.addEventListener('click', () => go({ view: 'notebook', pageId: p.id }));
    const move = make('select', 'move');
    move.setAttribute('aria-label', `Move ${p.title || 'page'} to a world`);
    move.append(Object.assign(make('option', '', 'Move to…'), { value: '' }), ...bookOpts.map((b) => Object.assign(make('option', '', b.title), { value: b.id })));
    move.addEventListener('change', async () => {
      if (!move.value) return;
      await putEntries([{ ...p, parent_id: move.value, updated_at: Date.now() }]);
      renderLibrary();
      renderRail();
    });
    onContextMenu(open, () => pageMenu(p));
    li.append(open, make('span', 'when', ago(p.updated_at)), move, menuButton(() => pageMenu(p), `More for ${p.title || 'this page'}`));
    return li;
  }));
  $('#lib-loose-box').hidden = !loose.length;
  await renderTrash();
}

function addAreaChip(parentId) {
  const b = make('button', 'chip add', '+');
  b.setAttribute('aria-label', parentId ? 'Add an area inside this one' : 'Add an area');
  b.addEventListener('click', () => {
    const input = make('input', 'chip-input');
    input.placeholder = 'New area';
    b.replaceWith(input);
    input.focus();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title) {
        const area = await newArea(title, parentId);
        await go({ view: 'library', area: area.id });
      } else renderLibrary();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
  });
  return b;
}

async function areaOptions(allAreas) {
  const out = [];
  const walk = (parentId, depth) => {
    for (const a of allAreas.filter((x) => (x.parent_id || null) === parentId)) {
      out.push([a.id, `${' '.repeat(depth)}${a.title}`]);
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

async function showNewBook(type) {
  if (view() !== 'library') await go({ view: 'library' });
  const form = $('#lib-new');
  form.hidden = false;
  $('#lib-new-type').value = type;
  $('#lib-new-title').value = '';
  $('#lib-new-title').focus();
}

$('#lib-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#lib-new-title').value.trim();
  if (!title) return;
  const type = $('#lib-new-type').value;
  const area = $('#lib-new-area').value || null;
  const world = type === 'world' ? await newWorld(title, area) : await worldOf(await newBook(type, title, area));
  $('#lib-new').hidden = true;
  // A new world opens on its Idea page, the place to think it through.
  const idea = (await pagesIn(world.id))[0];
  if (idea) await go({ view: 'notebook', pageId: idea.id });
  else await go({ view: 'world', id: world.id });
});
$('#lib-new-cancel').addEventListener('click', () => { $('#lib-new').hidden = true; });

// ---------- a book's home ----------

async function renderProject() {
  const b = await getEntry(state.bookId);
  if (gone(b)) return go({ view: 'library' });
  const s = await stats(b);
  // A notes collection that was once a novel still shows its manuscript.
  const novel = hasManuscript(b) || s.words > 0;
  const title = $('#ph-title');
  title.textContent = b.title;
  title.contentEditable = 'true';
  title.onblur = async () => {
    const t = title.textContent.trim();
    if (!t) title.textContent = b.title;
    if (t && t !== b.title) { await putEntries([{ ...b, title: t, updated_at: Date.now() }]); if (state.project?.id === b.id) state.project.title = t; renderRail(); renderCrumb(); }
  };
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { e.preventDefault(); title.textContent = b.title; title.blur(); } };
  $('#ph-more').replaceChildren(menuButton(() => bookMenu(b), 'More for this piece'));
  const kindSel = $('#ph-kind');
  const formats = bookType(b) === 'notes' ? [...KINDS, ['notes', 'Pages']] : KINDS;
  kindSel.replaceChildren(...formats.map(([id, label]) => Object.assign(make('option', '', label), { value: id })));
  kindSel.value = bookType(b);
  kindSel.onchange = async () => { const to = kindSel.value; kindSel.value = bookType(b); await setKind(b, to); };
  // What it is, in your own words: type over it; earlier labels are offered.
  const label = $('#ph-label');
  label.value = kindName(b);
  $('#piece-labels').replaceChildren(...(await usedLabels()).map((v) => Object.assign(make('option'), { value: v })));
  label.onchange = async () => {
    const fresh = await getEntry(b.id);
    const v = label.value.trim();
    const fields = { ...fresh.fields };
    if (v && v !== defaultLabel(bookType(fresh))) fields.label = v; else delete fields.label;
    if (JSON.stringify(fields) === JSON.stringify(fresh.fields)) return;
    await putEntries([{ ...fresh, fields, updated_at: Date.now() }]);
    renderRail();
  };
  label.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); label.blur(); } };
  const stageSel = $('#ph-stage');
  stageSel.replaceChildren(...STAGES.map((st) => Object.assign(make('option', '', st), { value: st })));
  stageSel.value = stageOf(b);
  stageSel.onchange = () => setStage(b, stageSel.value);
  $('#ph-stats').textContent = bookType(b) === 'screenplay'
    ? `${s.words.toLocaleString()} words`
    : novel
    ? `${s.words.toLocaleString()} words · ${s.chapters.length} chapter${s.chapters.length === 1 ? '' : 's'}`
    : `${s.pages} page${s.pages === 1 ? '' : 's'}${s.words ? ` · ${s.words.toLocaleString()} words in its manuscript` : ''}`;
  const world = await worldOf(b);
  const inWorld = $('#ph-world');
  inWorld.replaceChildren();
  if (world) {
    const wb = make('button', '', world.title || 'Untitled');
    wb.addEventListener('click', () => go({ view: 'world', id: world.id }));
    inWorld.append(document.createTextNode('In '), wb);
  }

  const cont = $('#ph-continue');
  const outlined = bookType(b) === 'lines';
  cont.hidden = !outlined && (!novel || !s.chapters.length);
  if (outlined) {
    cont.textContent = 'Open the outline';
    cont.onclick = () => go({ view: 'notebook', pageId: b.id });
  } else if (novel && s.chapters.length) {
    const last = await getMeta(`lastChapter:${b.id}`);
    const ch = s.chapters.find((c) => c.id === last) || s.chapters[0];
    cont.textContent = `Continue writing · ${ch.title}`;
    cont.onclick = () => go({ view: 'write', chapterId: ch.id });
  }

  $('#ph-ms-label').hidden = !novel;
  const ms = $('#ph-manuscript');
  ms.replaceChildren();
  if (novel) {
    for (const act of s.acts) {
      const box = make('div', 'ms-act');
      const head = make('div', 'ms-act-title');
      head.append(make('span', '', act.title), menuButton(() => actMenu(act), `More for ${act.title}`));
      onContextMenu(head, () => actMenu(act));
      box.append(head);
      for (const ch of act.chapters) {
        const row = make('div', 'ms-row');
        const c = make('button', 'ms-chapter');
        c.append(make('span', '', ch.title), make('span', 'when', `${(ch.fields?.words || 0).toLocaleString()} words`));
        c.addEventListener('click', () => go({ view: 'write', chapterId: ch.id }));
        onContextMenu(c, () => chapterMenu(ch));
        row.append(c, menuButton(() => chapterMenu(ch), `More for ${ch.title}`));
        box.append(row);
      }
      ms.append(box);
    }
  }

  const inside = await piecesIn(b.id);
  $('#ph-pieces').replaceChildren(...inside.map((x) => pieceRow(x, 0)));
  $('#ph-new-piece').onclick = () => addPiece(b.id);
  const pages = await pagesIn(b.id);
  // Empty sections stay out of the way: just the two ways to add one.
  $('#ph-pieces-head').hidden = !inside.length;
  $('#ph-new-piece-quiet').hidden = inside.length > 0;
  $('#ph-new-piece-quiet').onclick = () => addPiece(b.id);
  $('#ph-pages-label').style.visibility = pages.length ? '' : 'hidden';
  $('#ph-pages').replaceChildren(...pages.map((p) => {
    const li = make('li');
    const open = make('button', 'loose-title', p.title || 'Untitled page');
    open.addEventListener('click', () => go({ view: 'notebook', pageId: p.id }));
    onContextMenu(open, () => pageMenu(p));
    li.append(open, make('span', 'when', ago(p.updated_at)), menuButton(() => pageMenu(p), `More for ${p.title || 'this page'}`));
    return li;
  }));

  const mentions = await dailyMentions(b);
  $('#ph-daily').replaceChildren(...mentions.map(({ row, day }) => {
    const li = make('li');
    const btn = make('button');
    btn.append(make('span', 'from', titleOf(day)), make('span', 'line', row.text));
    btn.addEventListener('click', () => go({ view: 'notebook', pageId: day.id, line: row.id }));
    li.append(btn);
    return li;
  }));
  $('#ph-daily-empty').hidden = mentions.length > 0;
}

// One piece in a list: its name, what it is and its stage.
function pieceRow(p, depth) {
  const li = make('li');
  li.style.setProperty('--depth', depth);
  const open = make('button', 'loose-title', p.title || 'Untitled');
  open.addEventListener('click', () => go({ view: 'project', id: p.id }));
  onContextMenu(open, () => bookMenu(p));
  const stage = make('button', 'stage', stageOf(p));
  stage.title = 'Stage';
  stage.addEventListener('click', (e) => popMenu(stage, STAGES.map((st) => ({ label: st, current: stageOf(p) === st, run: () => setStage(p, st) }))));
  li.append(open, make('span', 'piece-kind', kindName(p)), stage, menuButton(() => bookMenu(p), `More for ${p.title || 'this piece'}`));
  return li;
}

// ---------- a world's home: its pieces and its bible ----------

async function renderWorld() {
  const w = await getEntry(state.worldId);
  if (gone(w)) return go({ view: 'library' });
  const allAreas = await areas();
  const s = await worldStats(w);
  const title = $('#wh-title');
  title.textContent = w.title;
  title.contentEditable = 'true';
  title.onblur = async () => {
    const t = title.textContent.trim();
    if (!t) title.textContent = w.title;
    if (t && t !== w.title) { await putEntries([{ ...(await getEntry(w.id)), title: t, updated_at: Date.now() }]); renderRail(); renderCrumb(); }
  };
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { e.preventDefault(); title.textContent = w.title; title.blur(); } };
  $('#wh-more').replaceChildren(menuButton(() => worldMenu(w), 'More for this world'));
  const n = (x, word) => `${x.toLocaleString()} ${word}${x === 1 ? '' : 's'}`;
  $('#wh-stats').textContent = [n(s.pieces.length, 'piece'), s.words && n(s.words, 'word'), n(s.pages.length, 'page')].filter(Boolean).join(' · ');
  const areaSel = $('#wh-area');
  areaSel.replaceChildren(...(await areaOptions(allAreas)).map(([id, label]) => Object.assign(make('option', '', label), { value: id })));
  areaSel.value = w.area_id || '';
  areaSel.onchange = () => moveBookToArea(w, areaSel.value);

  // Carry on with the piece you were last writing in this world.
  const cont = $('#wh-continue');
  const last = await getMeta('lastChapter');
  const lastCh = last && (await getEntry(last));
  const lastPiece = lastCh && !gone(lastCh) ? await bookOf(lastCh) : null;
  const here = lastPiece && s.pieces.some((p) => p.row.id === lastPiece.id) ? lastPiece : s.pieces.find((p) => hasManuscript(p.row))?.row;
  cont.hidden = !here;
  if (here) {
    cont.textContent = s.pieces.length > 1 ? `Continue writing · ${here.title || 'Untitled'}` : 'Continue writing';
    cont.onclick = () => openBook(here.id);
  }

  $('#wh-pieces').replaceChildren(...s.pieces.map(({ row, depth }) => pieceRow(row, depth)));
  $('#wh-pieces-empty').hidden = s.pieces.length > 0;
  // The stage board: every piece by stage, one column each, instead of the list.
  const board = boardOn() && s.pieces.length > 0;
  const toggle = $('#wh-board-toggle');
  toggle.hidden = !s.pieces.length;
  toggle.textContent = board ? 'List' : 'Board';
  toggle.onclick = () => { try { localStorage.setItem('stageBoard', board ? 'list' : 'board'); } catch { /* full */ } renderWorld(); };
  $('#wh-pieces').hidden = board;
  $('#wh-board').hidden = !board;
  if (board) renderBoard(w, s.pieces);
  else $('#wh-board').replaceChildren();
  // Promises made in this world, and whether they've been paid off yet.
  const promises = await worldPromises(w);
  $('#wh-promises-box').hidden = !promises.length;
  $('#wh-promises').replaceChildren(...promises.map((p) => {
    const li = make('li', p.paid ? 'paid' : 'unpaid');
    const btn = make('button');
    const where = [p.thread?.title, p.piece?.title].filter(Boolean).join(' · ');
    btn.append(make('span', 'from', where), make('span', 'line', p.note.text || ''), make('span', 'state', p.paid ? `Paid off${p.payoffPiece && p.payoffPiece.id !== p.piece?.id ? ` in ${p.payoffPiece.title}` : ''}: ${p.payoff.text || ''}` : 'Not paid off yet'));
    btn.addEventListener('click', () => go({ view: 'grid', id: p.piece?.id || w.id }));
    li.append(btn);
    return li;
  }));
  $('#wh-new-piece').onclick = () => addPiece(w.id);

  const { pages } = await worldTree(w.id);
  $('#wh-pages').replaceChildren(...pages.map(({ row: p, depth }) => {
    const li = make('li');
    li.style.setProperty('--depth', depth);
    const open = make('button', 'loose-title', p.title || 'Untitled page');
    open.addEventListener('click', () => go({ view: 'notebook', pageId: p.id }));
    onContextMenu(open, () => pageMenu(p));
    li.append(open, make('span', 'when', ago(p.updated_at)), menuButton(() => pageMenu(p), `More for ${p.title || 'this page'}`));
    return li;
  }));
  $('#wh-pages-empty').hidden = pages.length > 0;

  const mentions = await dailyMentions(w);
  $('#wh-daily').replaceChildren(...mentions.map(({ row, day }) => {
    const li = make('li');
    const btn = make('button');
    btn.append(make('span', 'from', titleOf(day)), make('span', 'line', row.text));
    btn.addEventListener('click', () => go({ view: 'notebook', pageId: day.id, line: row.id }));
    li.append(btn);
    return li;
  }));
  $('#wh-daily-empty').hidden = mentions.length > 0;
}

// ---------- the plot grid: the manuscript as a table ----------

const grid = new PlotGrid($('#grid-view'), {
  // A row opens where it is in the text.
  async open(r) {
    if (r.focus) return openEntry(r.focus);
    if (r.kind === 'piece') return openBook(r.id);
    if (r.kind === 'act') { const ch = (await outline((await getEntry(r.id)).parent_id)).find((a) => a.id === r.id)?.chapters[0]; return ch ? go({ view: 'write', chapterId: ch.id }) : null; }
    if (r.kind === 'chapter' || (r.kind === 'opening' && r.id === r.chapterId)) return go({ view: 'write', chapterId: r.chapterId || r.id });
    if (r.chapterId) return go({ view: 'write', chapterId: r.chapterId, focus: r.id });
    return openEntry(r.id);
  },
  leave: (owner) => (owner.kind === 'world' ? go({ view: 'world', id: owner.id }) : openBook(owner.id)),
  changed(rows) {
    gridTouched = true;
    if (rows.some((r) => r && ['chapter', 'act', 'project'].includes(r.kind))) renderRail();
  },
  beforeMove: () => store.close(editor.state.doc),
  menu: (anchor, items) => popMenu(anchor, items),
  menuButton: (items, label) => menuButton(items, label),
  ask, askText, toast,
  noteType: () => notes.types[0]?.id || null,
  askServer: (body) => askServer(body),
  canAsk: () => canAskServer()
});
window.__grid = grid;

// ---------- revising: fresh eyes, print, drafts, compare, Claude's notes ----------

// Fresh eyes: one switch that makes the draft look unfamiliar (another kind
// of font, a narrower page, a different page colour), so it reads like
// someone else's. Per device, like the other view settings.
const freshEyes = () => root.classList.contains('fresh-eyes');
function setFreshFont() {
  const g = currentFont().group;
  root.style.setProperty('--fresh-prose', g === 'serif' ? "'iA Writer Quattro', Consolas, monospace" : "'Literata', Georgia, serif");
}
function toggleFreshEyes(on = !freshEyes()) {
  setFreshFont();
  root.classList.toggle('fresh-eyes', on);
  try { localStorage.setItem('freshEyes', on ? '1' : '0'); } catch { /* private window */ }
  $('#fresh-eyes').checked = on;
  notes.layout();
  toast(on ? 'Fresh eyes on: a new font, page and colour, so it reads like someone else’s' : 'Fresh eyes off');
}
try { if (localStorage.getItem('freshEyes') === '1') { setFreshFont(); root.classList.add('fresh-eyes'); } } catch { /* private window */ }
$('#fresh-eyes').checked = freshEyes();
$('#fresh-eyes').addEventListener('change', () => toggleFreshEyes($('#fresh-eyes').checked));

// The piece the revision tools are about, from where you are.
async function revisionPiece() {
  if (view() === 'compare') return getEntry(state.compareId);
  const id = await productionOwner();
  const b = id && (await getEntry(id));
  return b && hasManuscript(b) ? b : null;
}

// Ctrl + P: the piece as a manuscript or a script, ready to print or save as a PDF.
async function printCurrent() {
  if (inNotebook() && notebook.page && !notebook.isDay) {
    await notebook.close();
    const doc = await pageDoc(notebook.page);
    printPiece({ title: titleOf(notebook.page), type: 'page', chapters: doc, author: await accountName() });
    return;
  }
  const b = await revisionPiece();
  if (!b) { toast('Open a piece to print it'); return; }
  if (state.project?.id === b.id) await store.close(editor.state.doc);
  const chapters = await pieceDoc(b.id);
  const words = chapters.reduce((n, ch) => n + ch.blocks.reduce((m, x) => m + wordCount(x.text), 0), 0);
  printPiece({ title: b.title, type: bookType(b), chapters, words, author: await accountName() });
}
const accountName = async () => (window.__claude ? 'Michael' : (await sync.backend?.name?.().catch(() => '')) || '');

// Start again from scratch: the draft as it is now is kept whole, and the
// piece opens empty, with the old draft beside it to read from.
async function newDraft(piece) {
  const b = await getEntry(piece.id);
  const n = (b.fields?.draft || 1);
  const ok = await ask({
    title: `Start draft ${n + 1} of “${nameOf(b)}” from scratch?`,
    body: `Draft ${n} is kept whole, exactly as it is, with its notes${bookType(b) === 'screenplay' ? ', shots' : ''} and grid notes. The piece starts empty with the same ${bookType(b) === 'screenplay' ? 'script' : 'acts and chapters'}, and Draft ${n} opens beside it to read from. Compare the two any time.`,
    ok: `Start draft ${n + 1}`
  });
  if (!ok) return;
  if (state.project?.id === b.id) { await store.close(editor.state.doc); state.chapterId = null; }
  const { draft, first } = await startDraft(b, { script: bookType(b) === 'screenplay' });
  state.project = await getEntry(b.id);
  await go({ view: 'write', chapterId: first.id });
  await beside.open(b.id, first.id, { type: 'draft', id: draft.id });
  toast(`Draft ${n + 1}: a clean page. ${draft.title} is beside it (Ctrl + Shift + B hides it).`);
}

// Ctrl + Shift + B: an earlier draft (or the text as it was) beside the one you're writing.
const beside = new BesidePane($('.beside'), {
  pickDate: () => pickDate(),
  focus: () => editor.commands.focus()
});
window.__beside = beside;
// Caught before the editor sees it, which would otherwise make a block quote.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); toggleBeside(); }
}, true);
async function toggleBeside() {
  if (beside.isOpen) { beside.close(); editor.commands.focus(); return; }
  if (!writing() || !state.project || !state.chapterId) { toast('Open a chapter to read another draft beside it'); return; }
  await store.close(editor.state.doc);
  await beside.open(state.project.id, state.chapterId);
}

async function pickDate() {
  const got = await askText({ title: 'The text as it was on…', type: 'date', ok: 'Show it', value: '' });
  if (!got) return null;
  const [y, m, d] = got.split('-').map(Number);
  return y ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : null;
}

// Ctrl + Shift + X: compare two drafts, or the text then and now.
const comparer = new CompareView($('#compare-view'), {
  back: (piece) => openBook(piece.id),
  pickDate: () => pickDate(),
  remember: (place) => remember(place),
  ask: (b) => askServer(b),
  canAsk: () => canAskServer(),
  toast
});
window.__compare = comparer;
async function toggleCompare() {
  if (view() === 'compare') { const p = await getEntry(state.compareId); return p ? openBook(p.id) : go({ view: 'library' }); }
  const b = await revisionPiece();
  if (!b) { toast('Open a piece to compare its drafts'); return; }
  return go({ view: 'compare', id: b.id, focus: writing() ? state.chapterId : null });
}

// Claude's notes on the chapter you're in: margin notes and a fix list.
async function askClaudeNotes() {
  if (!writing() || !state.chapterId) { toast('Open a chapter for Claude to read'); return; }
  if (!canAskServer()) { toast('Sign in and go online to ask Claude'); return; }
  await store.close(editor.state.doc);
  const chapter = await getEntry(state.chapterId);
  statusEl.textContent = 'Claude is reading…';
  try {
    const ctx = await alts.context();
    const got = await claudeNotes(chapter, state.project, { ask: askServer, idea: ctx.idea });
    if (state.chapterId === chapter.id) { await notes.reloadTypes(); await notes.load(chapter.id); if (hidden().has('claude')) setShown('claude', true); notes.setVisible(true); }
    statusEl.textContent = 'Saved';
    const fixes = got.page ? (await children(got.page.id)).length : 0;
    toast(`Claude left ${plural(got.notes.length, 'note')} in the margin${fixes ? ' and a fix list' : ''}`, got.page ? { label: 'Open the fix list', run: () => go({ view: 'notebook', pageId: got.page.id }) } : null);
  } catch (e) {
    statusEl.textContent = 'Saved';
    toast(e.message || 'Couldn’t ask Claude. Try again.');
  }
}

const talk = new TalkPanel($('.talk'), {
  ask: (b) => askServer(b),
  canAsk: () => canAskServer(),
  toast,
  save: () => store.close(editor.state.doc),
  context: () => alts.context(),
  focus: () => editor.commands.focus()
});
window.__talk = talk;
async function toggleTalk() {
  if (talk.isOpen) { talk.close(); editor.commands.focus(); return; }
  if (!writing() || !state.chapterId) { toast('Open a chapter to talk it over'); return; }
  await talk.open(state.chapterId);
}

// ---------- share links: read and comment ----------

const sharing = new Sharing({
  backend: () => sync.backend,
  user: () => sync.user,
  onComments: async (fresh) => {
    if (state.chapterId && fresh.some((n) => n.fields?.chapter_id === state.chapterId)) await notes.load(state.chapterId);
    const where = [...new Set(fresh.map((n) => n.fields?.comment?.share))].length === 1 ? (await getEntry(fresh[0].fields.comment.share))?.title : null;
    toast(`${plural(fresh.length, 'new comment')}${where ? ` on “${where}”` : ''}`, fresh[0].fields?.chapter_id ? { label: 'Show', run: () => openEntry(fresh[0].parent_id).then(() => { if (hidden().has('comments')) setShown('comments', true); notes.setVisible(true); }) } : null);
  }
});
window.__sharing = sharing;
notes.comments = { reply: (n, t) => sharing.reply(n, t), resolve: (n) => sharing.resolve(n), toast };
notes.skip = (n) => (n.type === 'claude' && hidden().has('claude')) || (n.type === 'comment' && hidden().has('comments'));
setInterval(() => sharing.refresh().catch((e) => console.warn(e)), 120000);
document.addEventListener('visibilitychange', () => { if (document.hidden) sharing.refresh().catch(() => {}); });
setTimeout(() => sharing.refresh().catch(() => {}), 8000);

// What's shared from where you are: the piece, or the bible page.
async function shareTarget() {
  if (inNotebook() && notebook.page?.kind === 'page') return notebook.page;
  const id = await productionOwner();
  return id ? getEntry(id) : null;
}

async function openShare(target) {
  target = target || (await shareTarget());
  if (!target) { toast('Open a piece or a page to share it'); return; }
  if (state.project?.id === target.id) await store.close(editor.state.doc);
  if (inNotebook()) await notebook.close();
  document.querySelector('.share-panel')?.remove();
  const back = make('div', 'ask-backdrop');
  const box = make('div', 'ask share-panel');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Share a link');
  back.append(box);
  document.body.append(back);
  const close = () => { back.remove(); currentEditor().commands.focus(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  const draw = async () => {
    const share = await sharing.current(target);
    box.replaceChildren(make('h2', '', `Share “${titleOf(target)}”`));
    const btn = (label, cls, run) => { const b = make('button', cls, label); b.type = 'button'; b.addEventListener('click', run); return b; };
    if (!share) {
      box.append(make('p', '', `Anyone with the link can read ${target.kind === 'page' ? 'this page' : 'this piece'} and leave comments, without an account. Nothing else of yours is shared: not your notes, other pieces or day pages. It stays up to date as you write, and you can turn it off any time.`));
      const l = make('label', 'switch');
      const c = make('input');
      c.type = 'checkbox';
      c.checked = true;
      l.append(c, document.createTextNode(' Readers can comment'));
      box.append(l);
      const row = make('div', 'ask-actions');
      row.append(btn('Cancel', 'ghost-btn', close));
      if (!sharing.ready) {
        box.append(make('p', 'hint', sync.user ? 'You’re offline. Links are made online.' : 'Sign in to sync first: links are made through your account.'));
        if (!sync.user && sync.available) row.append(btn('Sign in', 'pill primary', () => sync.signIn()));
      } else {
        row.append(btn('Make a link', 'pill primary', async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Making it…';
          try { await sharing.start(target, { comments: c.checked }); await draw(); } catch (err) { e.target.disabled = false; e.target.textContent = 'Make a link'; toast(err.message || 'Couldn’t make the link. Try again.'); }
        }));
      }
      box.append(row);
      row.querySelector('.primary')?.focus();
      return;
    }
    const url = linkFor(share.fields.token);
    const field = make('input', 'ask-input share-url');
    field.readOnly = true;
    field.value = url;
    field.setAttribute('aria-label', 'The link');
    field.addEventListener('focus', () => field.select());
    const copy = btn('Copy the link', 'pill primary', async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { field.select(); } });
    const urlRow = make('div', 'share-row');
    urlRow.append(field, copy);
    box.append(urlRow);
    const l = make('label', 'switch');
    const c = make('input');
    c.type = 'checkbox';
    c.checked = !!share.fields.comments;
    c.addEventListener('change', async () => { try { await sharing.setComments(share, c.checked); } catch (err) { c.checked = !c.checked; toast(err.message || 'Couldn’t change that. Try again.'); } });
    l.append(c, document.createTextNode(' Readers can comment'));
    box.append(l, make('p', 'hint', share.fields.sent ? `Readers see it as of ${ago(share.fields.sent)}; new words go up every couple of minutes.` : 'Sending…'));
    const list = await commentsOn(share);
    if (list.length) {
      box.append(make('div', 'panel-label', `Comments (${list.length})`));
      const ul = make('ul', 'share-comments');
      for (const n of list.slice(0, 30)) {
        const li = make('li', n.fields.resolved ? 'resolved' : '');
        const b = make('button', '');
        b.type = 'button';
        b.append(make('b', '', n.fields.comment.name || 'A reader'), document.createTextNode(` ${n.text}`));
        b.addEventListener('click', async () => { close(); await openEntry(n.parent_id); if (n.fields.chapter_id) { if (hidden().has('comments')) setShown('comments', true); notes.setVisible(true); } });
        li.append(b);
        ul.append(li);
      }
      box.append(ul);
    }
    const row = make('div', 'ask-actions');
    row.append(btn('Stop sharing…', 'ghost-btn danger-text', async () => {
      const ok = await ask({ title: 'Turn this link off?', body: 'Anyone who opens it sees that it’s been turned off. Comments already in stay in your margin. A new link later is a new address.', ok: 'Turn it off', danger: true });
      if (!ok) return;
      try { await sharing.stop(share); await draw(); toast('Link turned off'); } catch (err) { toast(err.message || 'Couldn’t turn it off. Try again.'); }
    }), btn('Done', 'pill', close));
    box.append(row);
    copy.focus();
  };
  await draw();
}

// ---------- production: shots, the kit, shoot days, posting ----------

const production = new ProductionView($('#prod-view'), {
  open: (r) => grid.hooks.open(r),
  openPage: (id) => go({ view: 'notebook', pageId: id }),
  leave: (piece) => openBook(piece.id),
  changed(rows) { if (rows.some((r) => r && ['project', 'world', 'page'].includes(r.kind))) renderRail(); },
  menu: (anchor, items) => popMenu(anchor, items),
  menuButton: (items, label) => menuButton(items, label),
  ask, askText, toast,
  askServer: (body) => askServer(body),
  canAsk: () => canAskServer(),
  numberScenes: async (piece) => { await toggleNumbering(piece); await production.refresh(); },
  sendTask: async (task) => { await queueTask(task); await sendPending({ send: sendTask, canSend: canSendTask }); },
  base: () => location.origin + location.pathname
});
window.__production = production;

// The piece production is for, from where you are.
async function productionOwner() {
  if (view() === 'production') return state.prodId;
  if (view() === 'grid') { const g = await getEntry(state.gridId); return g?.kind === 'project' ? g.id : null; }
  if (view() === 'write') return state.project?.id || null;
  if (view() === 'project') return state.bookId;
  if (view() === 'world') { const w = await getEntry(state.worldId); return (await worldStats(w)).pieces.find((p) => hasManuscript(p.row))?.row.id || null; }
  return null;
}

// Ctrl+Shift+S: production, and back to the text.
async function toggleProduction() {
  if (view() === 'production') { const p = await getEntry(state.prodId); return p ? openBook(p.id) : go({ view: 'library' }); }
  const id = await productionOwner();
  if (!id) { toast('Open a script or draft to see its production'); return; }
  return go({ view: 'production', id });
}

// What the grid is for, from where you are: the piece you're writing or
// looking at, or the world.
async function gridOwner() {
  if (view() === 'write') return state.project?.id || null;
  if (view() === 'project') return state.bookId;
  if (view() === 'world') return state.worldId;
  if (view() === 'grid') return state.gridId;
  if (inNotebook() && notebook.page && !notebook.isDay) return (await bookOf(notebook.page))?.id || (await worldOf(notebook.page))?.id || null;
  return null;
}

// Ctrl+Shift+G: the grid, and back to the text.
async function toggleGrid() {
  if (view() === 'grid') { const g = await getEntry(state.gridId); return grid.hooks.leave(g); }
  const id = await gridOwner();
  if (!id) { toast('Open a piece or a world to see its plot grid'); return; }
  return go({ view: 'grid', id });
}

// ---------- the stage board: a world's pieces by stage ----------

const boardOn = () => { try { return localStorage.getItem('stageBoard') === 'board'; } catch { return false; } };

function renderBoard(w, pieces) {
  const touch = matchMedia('(hover: none)').matches;
  const cols = STAGES.map((stage) => {
    const col = make('section', 'sb-col');
    col.dataset.stage = stage;
    const mine = pieces.filter(({ row }) => stageOf(row) === stage);
    const head = make('div', 'sb-head');
    head.append(make('span', '', stage), make('span', 'sb-n', mine.length ? String(mine.length) : ''));
    col.append(head);
    for (const { row: p } of mine) {
      const card = make('button', 'sb-card');
      card.dataset.id = p.id;
      card.append(make('span', 'sb-title', p.title || 'Untitled'), make('span', 'sb-kind', kindName(p)));
      card.addEventListener('click', () => (touch ? popMenu(card, [
        { label: 'Open', run: () => go({ view: 'project', id: p.id }) },
        { label: 'Stage', sub: STAGES.map((st) => ({ label: st, current: stageOf(p) === st, run: () => setStage(p, st) })) }
      ]) : go({ view: 'project', id: p.id })));
      onContextMenu(card, () => bookMenu(p));
      if (!touch) {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-piece', p.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
      }
      col.append(card);
    }
    if (!touch) {
      col.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-piece')) { e.preventDefault(); col.classList.add('drop'); } });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
      col.addEventListener('drop', async (e) => {
        const id = e.dataTransfer.getData('text/x-piece');
        col.classList.remove('drop');
        if (!id) return;
        e.preventDefault();
        const p = pieces.find(({ row }) => row.id === id)?.row;
        if (p && stageOf(p) !== stage) await setStage(p, stage);
      });
    }
    return col;
  });
  $('#wh-board').replaceChildren(...cols);
}

// ---------- panels revealed by edges ----------

// The browser can fire a stray hover when the layout shifts (like turning focus on), so edges ignore it then.
let edgesQuietUntil = 0;
// On a touch screen an edge opens on a tap, never on a hover: phones send
// stray hover events when the page shifts (the keyboard opening, say).
const hovers = () => Date.now() > edgesQuietUntil && !matchMedia('(hover: none)').matches;
$('.edge-left').addEventListener('mouseenter', () => { if (hovers()) body.classList.add('show-outline'); });
$('.edge-left').addEventListener('click', () => body.classList.add('show-outline'));
$('.outline').addEventListener('mouseleave', () => body.classList.remove('show-outline'));
$('.edge-top').addEventListener('mouseenter', () => { if (hovers()) body.classList.add('show-top'); });
$('.edge-top').addEventListener('click', () => body.classList.add('show-top'));
$('.topbar').addEventListener('mouseleave', () => body.classList.remove('show-top'));
// On a touch screen there's no mouse to leave the bar, so a tap anywhere else tucks it away.
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' && !e.target.closest('.topbar, .edge-top')) body.classList.remove('show-top');
  if (e.pointerType !== 'mouse' && !e.target.closest('.outline, .edge-left')) body.classList.remove('show-outline');
});

// ---------- history: every version, what changed, and bringing things back ----------

// What history is about right now: the chapter being written, or the page open in the notebook.
function historyTarget() {
  if (inNotebook() && notebook.page) {
    return {
      root: notebook.page, name: titleOf(notebook.page), ed: notebook.editor,
      save: () => notebook.close(),
      reload: async () => { const doc = await notebook.store.refresh(); notebook.replaceDoc(doc, false); },
      replace: (doc) => notebook.replaceDoc(doc, true)
    };
  }
  if (writing() && state.chapterId) {
    return {
      root: store.chapter, name: store.chapter?.title || 'this chapter', ed: editor,
      save: () => store.close(editor.state.doc),
      reload: async () => { await store.close(editor.state.doc); editor.commands.setContent(await store.refresh(), { emitUpdate: false }); notes.layout(); refreshWords(); },
      replace: (doc) => editor.commands.setContent(doc, { emitUpdate: true })
    };
  }
  return null;
}

let historyAt = null;
let historyMode2 = 'changes';

const dayLabel = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
};

async function openHistory() {
  const panel = $('.history');
  if (!panel.hidden) { closeHistory(); return; }
  const t = historyTarget();
  if (!t) { toast('Open a chapter or a page to see its history'); return; }
  await t.save();
  historyAt = t;
  panel.hidden = false;
  $('#history-title').textContent = `History · ${t.name}`;
  await renderHistoryList();
}

function closeHistory() {
  $('.history').hidden = true;
  historyAt = null;
  currentEditor().commands.focus();
}

async function renderHistoryList(pick) {
  const t = historyAt;
  if (!t) return;
  const list = $('#history-list');
  list.replaceChildren();
  const [versions, deleted] = await Promise.all([versionsOf(t.root.id), deletedFrom(t.root)]);
  const item = (cls, top, sub, run) => {
    const li = make('li');
    const b = make('button', cls);
    b.append(make('div', 'when', top), make('div', 'meta', sub));
    b.addEventListener('click', () => { list.querySelectorAll('button').forEach((x) => x.classList.toggle('current', x === b)); run(); });
    li.append(b);
    list.append(li);
    return b;
  };
  let first = null;
  if (deleted.length) {
    const what = t.root.kind === 'chapter' ? 'paragraph' : 'line';
    const b = item('history-deleted', `Deleted ${what}s`, `${deleted.length} you can bring back`, () => showDeleted(deleted));
    if (pick === 'deleted') first = b;
  }
  let day = '';
  versions.forEach((v, i) => {
    const label = dayLabel(v.at);
    if (label !== day) { day = label; list.append(Object.assign(make('li', 'history-day'), { textContent: label })); }
    const older = versions[i + 1];
    const diff = older ? v.words - older.words : 0;
    const change = !older ? 'first kept' : diff > 0 ? `+${diff.toLocaleString()} words` : diff < 0 ? `−${(-diff).toLocaleString()} words` : 'words changed';
    const time = new Date(v.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const b = item('', `${time}${v.label ? ` · ${v.label}` : ''}`, `${v.words.toLocaleString()} words · ${change}`, () => showVersion(v));
    if (!first && i === 0 && pick !== 'deleted') first = b;
  });
  if (!versions.length && !deleted.length) {
    list.append(Object.assign(make('li', 'hint'), { textContent: 'Nothing yet. A version is kept each time you pause typing.' }));
    $('#history-meta').textContent = '';
    $('#history-doc').replaceChildren();
    $('.history-actions').hidden = true;
    $('.history-modes').hidden = true;
  }
  first?.click();
}

let historyPick = null;
function showVersion(v) {
  historyPick = v;
  $('.history-modes').hidden = false;
  $('.history-actions').hidden = false;
  $('#history-meta').textContent = `${dayLabel(v.at)}, ${new Date(v.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${v.words.toLocaleString()} words`;
  document.querySelectorAll('.history-modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === historyMode2));
  const box = $('#history-doc');
  box.replaceChildren();
  box.classList.toggle('outline-like', historyAt.root.kind !== 'chapter');
  if (historyMode2 === 'read') {
    for (const bl of docBlocks(v.doc)) box.append(blockEl(bl, 'same'));
    return;
  }
  const changes = compare(v.doc, historyAt.ed.getJSON());
  if (changes.every((c) => c.op === 'same')) box.append(make('p', 'hint', 'This is the same as now.'));
  for (const c of changes) {
    const el = blockEl(c.block, c.op, c.words);
    if (c.op === 'del') {
      const back = make('button', 'ghost-btn history-back', 'Bring back');
      back.addEventListener('click', async () => {
        insertBlock(historyAt, c.block, c.after);
        await historyAt.save();
        back.replaceWith(make('span', 'hint', 'Back in the text'));
        el.classList.add('brought');
      });
      el.append(back);
    }
    box.append(el);
  }
}

// One paragraph or line of a version, marked by how it changed since.
function blockEl(bl, op, wordsDiff) {
  const p = make('div', `hb hb-${op}${bl.scene ? ' hb-scene' : ''}`);
  if (bl.line) p.style.paddingLeft = `${bl.depth * 22}px`;
  const text = make('span', 'hb-text');
  if (op === 'chg' && wordsDiff) for (const w of wordsDiff) text.append(w.op === '=' ? document.createTextNode(w.t) : make(w.op === '-' ? 'del' : 'ins', '', w.t));
  else text.textContent = bl.scene ? `§ ${bl.text || 'Scene'}` : bl.text || ' ';
  p.append(text);
  if (op === 'del') p.title = 'Taken out since this version';
  if (op === 'ins') p.title = 'Added since this version';
  return p;
}

// Put a paragraph (or line) from an old version back into the text, after the
// one it used to follow.
function insertBlock(t, bl, afterEid) {
  const ed = t.ed;
  let node = bl.node;
  if (node.type === 'listItem') node = { ...node, content: (node.content || []).filter((c) => c.type !== 'bulletList') };
  let at = null;
  ed.state.doc.descendants((n, pos) => {
    if (at !== null) return false;
    if (afterEid && n.attrs?.eid === afterEid && (n.type.name === 'listItem' || !node.type.startsWith('list'))) { at = pos + n.nodeSize; return false; }
    return true;
  });
  if (at === null) at = node.type === 'listItem' ? 1 : 0;
  ed.chain().insertContentAt(at, node).run();
}

function showDeleted(rows) {
  historyPick = null;
  $('.history-modes').hidden = true;
  $('.history-actions').hidden = true;
  const what = historyAt.root.kind === 'chapter' ? 'paragraphs' : 'lines';
  $('#history-meta').textContent = `Deleted ${what}, newest first. Each comes back where it was.`;
  const box = $('#history-doc');
  box.replaceChildren();
  box.classList.remove('outline-like');
  for (const r of rows) {
    const p = make('div', 'hb hb-del');
    p.append(make('span', 'hb-text', r.text), make('span', 'hb-when', `deleted ${ago(r.updated_at)}`));
    const back = make('button', 'ghost-btn history-back', 'Bring back');
    back.addEventListener('click', async () => {
      await historyAt.save();
      await bringBack(r, historyAt.root);
      await historyAt.reload();
      back.replaceWith(make('span', 'hint', 'Back in the text'));
      p.classList.add('brought');
    });
    p.append(back);
    box.append(p);
  }
}

$('.history-modes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || !historyPick) return;
  historyMode2 = b.dataset.mode;
  showVersion(historyPick);
});

$('#history-restore').addEventListener('click', async () => {
  const t = historyAt;
  if (!historyPick || !t) return;
  const ok = await ask({
    title: 'Go back to this version?',
    body: 'The text as it is now is kept in the history first, so you can come back to it.',
    ok: 'Go back to it'
  });
  if (!ok) return;
  await t.save();
  const now = t.ed.getJSON();
  await keep(t.root.id, now, t.ed.getText(), { force: true, label: 'Before going back' });
  t.replace(historyPick.doc);
  await t.save();
  closeHistory();
  toast('Back to the earlier version. The one before is in History.');
});
$('#history-copy').addEventListener('click', () => {
  if (historyPick) navigator.clipboard.writeText(docBlocks(historyPick.doc).map((b) => b.text).join('\n\n'));
  toast('Copied');
});

// ---------- page width and text size (per device) ----------

const DEFAULT_WIDTH = 660;
const defaultSize = () => (matchMedia('(max-width: 700px)').matches ? 18 : 21);
const currentWidth = () => Number(localStorage.getItem('pageWidth')) || DEFAULT_WIDTH;
const currentSize = () => Number(localStorage.getItem('textSize')) || defaultSize();

function setPage(width, size) {
  width = Math.max(420, Math.min(1100, width));
  size = Math.max(14, Math.min(30, size));
  root.style.setProperty('--page-width', `${width}px`);
  root.style.setProperty('--text-size', `${size}px`);
  localStorage.setItem('pageWidth', String(width));
  localStorage.setItem('textSize', String(size));
  $('#page-width').value = width;
  $('#text-size').value = size;
  $('#width-value').textContent = `${width}px`;
  $('#size-value').textContent = `${size}px`;
  notes.layout();
}

function togglePageSettings() {
  const panel = $('.page-settings');
  if (!panel.hidden) { panel.hidden = true; currentEditor().commands.focus(); return; }
  setPage(currentWidth(), currentSize());
  loadPreviews();
  showFonts();
  panel.hidden = false;
  $('#page-width').focus();
}

// Display switches, per device: anything beyond the text can be turned off.
const hidden = () => { try { return new Set(JSON.parse(localStorage.getItem('hide') || '[]')); } catch { return new Set(); } };
function setShown(name, on) {
  const h = hidden();
  if (on) h.delete(name); else h.add(name);
  localStorage.setItem('hide', JSON.stringify([...h]));
  root.classList.toggle(`hide-${name}`, !on);
  if (name === 'claude' || name === 'comments') notes.render();
  if (name === 'linkpics') resetLinkPics();
  syncSwitches();
}
// Reading a script through: only the script pages, no sections, notes or tools.
function toggleReading() {
  const on = !root.classList.contains('reading');
  if (on !== root.classList.contains('focus')) toggleFocus();
  root.classList.toggle('reading', on);
}

function toggleFocus() {
  const on = !root.classList.contains('focus');
  root.classList.toggle('focus', on);
  if (!on) root.classList.remove('reading');
  localStorage.setItem('focus', on ? '1' : '0');
  edgesQuietUntil = Date.now() + 600;
  body.classList.remove('show-outline', 'show-top');
  syncSwitches();
}
function syncSwitches() {
  const h = hidden();
  document.querySelectorAll('[data-show]').forEach((c) => { c.checked = !h.has(c.dataset.show); });
  $('#focus-mode').checked = root.classList.contains('focus');
  $('#focus-toggle').setAttribute('aria-pressed', String(root.classList.contains('focus')));
}

// Next or previous chapter in the book, or day on a daily page.
async function step(dir) {
  if (inNotebook()) return notebook.step(dir);
  if (!writing() || !state.project) return;
  const chapters = (await outline(state.project.id)).flatMap((a) => a.chapters);
  const i = chapters.findIndex((c) => c.id === state.chapterId);
  const next = chapters[i + dir];
  if (next) go({ view: 'write', chapterId: next.id });
}

const progressPanel = new StatsPanel($('.stats'), { onClose: () => currentEditor().commands.focus() });
document.addEventListener('visibilitychange', () => { if (document.hidden) recordProgress().catch(() => {}); });
// Once things have settled after opening.
setTimeout(() => recordProgress().catch((e) => console.error(e)), 20000);
const toggleShortcuts = () => { const s = $('.shortcuts'); s.hidden = !s.hidden; if (s.hidden) currentEditor().commands.focus(); };
document.querySelectorAll('[data-show]').forEach((c) => c.addEventListener('change', () => setShown(c.dataset.show, c.checked)));
$('#focus-mode').addEventListener('change', toggleFocus);
$('#typewriter-mode').checked = root.classList.contains('typewriter');
$('#typewriter-mode').addEventListener('change', toggleTypewriter);
syncSwitches();

$('#page-width').addEventListener('input', (e) => setPage(Number(e.target.value), currentSize()));
$('#text-size').addEventListener('input', (e) => setPage(currentWidth(), Number(e.target.value)));
$('#page-reset').addEventListener('click', () => { setPage(DEFAULT_WIDTH, defaultSize()); pickFont(DEFAULT_FONT); });

// Font picker: Serif / Sans / Mono, then each font written in its own face.
let fontGroup = null;
function showFonts() {
  const cur = currentFont();
  fontGroup ||= cur.group;
  $('#font-value').textContent = cur.name;
  $('.font-groups').replaceChildren(...FONT_GROUPS.map(([g, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.setAttribute('role', 'tab');
    b.classList.toggle('current', g === fontGroup);
    b.setAttribute('aria-selected', String(g === fontGroup));
    b.addEventListener('click', () => { fontGroup = g; showFonts(); });
    return b;
  }));
  $('.font-list').replaceChildren(...FONTS.filter((f) => f.group === fontGroup).map((f) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.font = f.id; b.setAttribute('role', 'radio');
    const name = document.createElement('span'), about = document.createElement('span');
    name.className = 'font-name'; name.textContent = f.name;
    about.className = 'font-about'; about.textContent = f.about;
    b.append(name, about);
    b.classList.toggle('current', f === cur);
    b.setAttribute('aria-checked', String(f === cur));
    b.addEventListener('click', () => pickFont(f.id));
    return b;
  }));
}
function pickFont(id) {
  setFont(id);
  fontGroup = currentFont().group;
  showFonts();
  notes.layout();
}
$('#page-done').addEventListener('click', togglePageSettings);

// ---------- command menu (⌘K) and go-to (⌘O) ----------

const mod = '⌘'; // shown as Ctrl+ off a Mac, see keys.js
showKeysForThisComputer();

function toggleTheme() {
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
}

function cycleFont() {
  const i = FONTS.indexOf(currentFont());
  setFont(FONTS[(i + 1) % FONTS.length].id);
  toast(currentFont().name);
}

async function exportChapter() {
  await store.close(editor.state.doc);
  const ch = await getEntry(state.chapterId);
  download(`${ch.title}.md`, chapterMarkdown(ch, await children(ch.id)));
}

async function exportVault() {
  await store.close(editor.state.doc);
  await notebook.close();
  download(`Inkwell vault ${isoToday()}.zip`, await vaultZip());
}

async function exportFountain() {
  await store.close(editor.state.doc);
  const rows = [];
  for (const act of state.acts) for (const ch of act.chapters) rows.push(...(await children(ch.id)));
  download(`${state.project.title}.fountain`, toFountain(state.project.title, rows));
}

// What a script calls its section levels, top down, in your own words.
async function nameSectionLevels() {
  const b = await getEntry(state.project.id);
  const now = b.fields?.sections || SECTION_NAMES.slice(0, 4);
  const got = await askText({ title: 'Section levels', body: 'Top level first, separated by commas. For example: Act, Sequence, Scene.', value: now.join(', '), ok: 'Save' });
  if (!got) return;
  const names = got.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
  if (!names.length) return;
  const next = { ...b, fields: { ...b.fields, sections: names }, updated_at: Date.now() };
  await putEntries([next]);
  state.project = next;
  await store.close(editor.state.doc);
  const id = state.chapterId;
  state.chapterId = null;
  await openChapter(id);
}

// Bring in a script: a .fountain file, or Fountain pasted from an outliner.
// It becomes a new screenplay piece in the world you're in (or another, or a
// world of its own), sections nested as they were.
async function importFountain() {
  const here = state.worldId && (await getEntry(state.worldId));
  const others = (await worlds()).filter((w) => w.id !== here?.id).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const places = [...(here && !gone(here) ? [[here.id, here.title || 'Untitled']] : []), ['', 'A new world of its own'], ...others.map((w) => [w.id, w.title || 'Untitled'])];
  const got = await askScript({ places });
  if (!got) return;
  const { title, lines } = looksLikeOutline(got.text) ? fromOutline(got.text) : fromFountain(got.text);
  if (!lines.length) { toast('That doesn’t look like a script: nothing came in.'); return; }
  const name = title || got.name || 'Untitled script';
  let book;
  if (got.into) book = await newPiece(got.into, 'screenplay', name, lines);
  else book = await newBook('screenplay', name, (await areas())[0]?.id || null, lines);
  await refreshViews();
  await openBook(book.id);
  const sections = lines.filter((l) => l.el === 'section').length;
  const scenes = lines.filter((l) => l.el === 'scene').length;
  toast(`“${name}” is in: ${plural(scenes, 'scene')}${sections ? `, ${plural(sections, 'section')}` : ''}`);
}

async function exportBook() {
  await store.close(editor.state.doc);
  download(`${state.project.title}.md`, await bookMarkdown(state.project, state.acts));
}

const writing = () => view() === 'write';
const commands = [
  { group: 'go', label: 'Go to… a book, chapter or page', keys: `${mod}O`, run: () => openPalette('go') },
  { group: 'go', label: 'Search inside all your writing', keys: `${mod}⇧F`, run: () => openPalette('search') },
  { group: 'go', label: 'Library', keys: `${mod}⇧O`, run: () => go({ view: 'library', area: null }) },
  { group: 'go', label: 'Tags: every tag, grouped', keys: '', run: () => go({ view: 'tags' }) },
  { group: 'go', label: 'Today’s page', keys: `${mod}J`, run: () => go({ view: 'notebook', pageId: dayId(isoToday()) }) },
  { group: 'go', label: 'Back to writing', keys: `${mod}J`, run: () => go({ view: 'write' }), when: () => !writing() },
  { group: 'go', label: 'Next chapter (or day)', keys: `${mod}⌥↓`, run: () => step(1), when: () => writing() || inNotebook() },
  { group: 'go', label: 'Previous chapter (or day)', keys: `${mod}⌥↑`, run: () => step(-1), when: () => writing() || inNotebook() },
  { group: 'new', label: 'Capture an idea by voice', keys: '⌥C', run: () => openCapture() },
  { group: 'new', label: 'Talk into the draft here (Claude writes it up)', keys: '⌥V', words: ['dictate', 'voice', 'walk', 'speak'], run: () => talkIntoDraft(), when: () => writing() },
  { group: 'new', label: 'Capture from a recording file…', words: ['audio', 'voice memo', 'upload'], run: () => fromRecordingFile(false) },
  { group: 'new', label: 'Draft from a recording file…', words: ['audio', 'voice memo', 'upload'], run: () => fromRecordingFile(true), when: () => writing() },
  { group: 'write', label: 'Your voice modes (shared with Scribe)…', words: ['journal', 'scene', 'idea', 'email', 'mode'], run: () => openModes() },
  { group: 'new', label: 'New novel', keys: '', run: () => showNewBook('novel') },
  { group: 'new', label: 'New screenplay', keys: '', run: () => showNewBook('screenplay') },
  { group: 'new', label: 'New notes collection', keys: '', run: () => showNewBook('notes') },
  { group: 'new', label: 'Bring in a script (Fountain file or pasted text)…', keys: '', run: importFountain },
  { group: 'new', label: 'New page', keys: '', run: newPageHere },
  { group: 'new', label: 'New area', keys: '', run: () => go({ view: 'library' }).then(() => [...document.querySelectorAll('#lib-areas .chip.add')].at(-1)?.click()) },
  { group: 'new', label: 'New chapter', keys: '', run: () => go({ view: 'write' }).then(newChapter), when: () => !!state.project },
  { group: 'new', label: 'New act', keys: '', run: () => go({ view: 'write' }).then(newAct), when: () => !!state.project },
  { group: 'write', label: 'Zoom into this line', keys: 'click its handle', run: () => notebook.zoomTo(notebook.currentLine()), when: inNotebook },
  { group: 'write', label: 'Zoom out', keys: 'Esc', run: () => notebook.zoomTo(null), when: () => inNotebook() && !!notebook.zoom },
  { group: 'write', label: 'Fold or unfold this line', keys: `${mod}↑ ${mod}↓`, run: () => notebook.toggleFold(), when: inNotebook },
  ...ELEMENTS.map((x) => ({ group: 'write', label: `Script: ${x.label}`, keys: 'Tab', run: () => editor.chain().focus().updateAttributes('paragraph', { el: x.id }).run(), when: () => writing() && isScript() })),
  { group: 'write', label: 'Script: Section (your own heading)', keys: '# ', run: () => { insertSection(editor.state.selection.$from.before(1)); }, when: () => writing() && isScript() },
  { group: 'write', label: 'Insert the time', keys: `${mod}⇧;`, run: () => insertTime(currentEditor()), when: () => writing() || inNotebook() },
  { group: 'write', label: 'Insert today’s date', keys: `${mod};`, run: () => insertDay(currentEditor(), 0), when: () => writing() || inNotebook() },
  { group: 'write', label: 'Insert something (time, date, link…)', keys: '/', run: () => typeHere(currentEditor(), '/'), when: () => writing() || inNotebook() },
  { group: 'write', label: 'Link to a page…', keys: '[[', run: () => openPicker(currentEditor()), when: () => writing() || inNotebook() },
  { group: 'write', label: 'Add a note to this paragraph', keys: `${mod}⇧N`, run: () => notes.add(), when: writing },
  { group: 'write', label: 'Alternates for this word (or the selection)', keys: `${mod}⇧E`, run: () => alts.open({ scope: 'word', focusAdd: true }), when: writing },
  { group: 'write', label: 'Versions of this paragraph', keys: '', run: () => alts.open({ scope: 'para' }), when: writing },
  { group: 'write', label: 'New version of this paragraph to rewrite', keys: `${mod}⇧D`, run: () => newParagraphVersion(editor), when: writing },
  { group: 'write', label: 'Next alternate (word, or else paragraph)', keys: '⌥↓', run: () => flip(editor, 1), when: writing },
  { group: 'write', label: 'Previous alternate', keys: '⌥↑', run: () => flip(editor, -1), when: writing },
  { group: 'write', label: 'Scene break', keys: `${mod}⇧↵`, run: () => editor.chain().focus().insertSceneBreak().run(), when: writing },
  { group: 'write', label: 'History: earlier versions, and what was deleted (this chapter or page)', keys: `${mod}⇧H`, run: openHistory, when: () => writing() || (inNotebook() && !!notebook.page) },
  { group: 'write', label: 'Note categories: add, rename, recolour', keys: '', run: () => notes.editTypes() },
  { group: 'view', label: 'Sidebar (keep open)', keys: `${mod}1`, run: () => body.classList.toggle('pin-outline') },
  { group: 'view', label: 'Notes beside the text', keys: `${mod}2`, run: () => toggleNotes(), when: writing },
  { group: 'view', label: 'Read it through: just the script pages', keys: 'Esc to stop', run: toggleReading, when: () => writing() && isScript() },
  { group: 'view', label: 'Focus: just the text (on / off)', keys: `${mod}.`, run: toggleFocus },
  { group: 'view', label: 'Typewriter mode: the line you’re on stays put', words: ['scroll', 'center', 'middle'], run: () => toggleTypewriter() },
  { group: 'view', label: 'Show or hide earlier days (under the day page)', keys: '', run: () => notebook.togglePastDays(), when: () => inNotebook() && notebook.isDay },
  { group: 'view', label: 'Show or hide "Linked from"', keys: '', run: () => setShown('links', hidden().has('links')) },
  { group: 'view', label: 'Show or hide note dots', keys: '', run: () => setShown('dots', hidden().has('dots')) },
  { group: 'view', label: 'Show or hide alternate marks', keys: '', run: () => setShown('alts', hidden().has('alts')) },
  { group: 'view', label: 'Show or hide the six-dot handle', keys: '', run: () => setShown('handle', hidden().has('handle')) },
  { group: 'view', label: 'Show or hide bullets on notebook lines', keys: '', run: () => setShown('bullets', hidden().has('bullets')) },
  { group: 'view', label: 'Show or hide pictures on shared links', keys: '', run: () => setShown('linkpics', hidden().has('linkpics')) },
  { group: 'view', label: 'Show or hide mode chips on voice captures', keys: '', run: () => setShown('voice', hidden().has('voice')) },
  { group: 'view', label: 'Progress: words and pages over time (stats)', keys: `${mod}⇧P`, run: () => progressPanel.open() },
  { group: 'write', label: 'Move this line to another page or day…', keys: '', run: moveLinePicker, when: inNotebook },
  { group: 'write', label: 'Gather a #tag onto this page…', keys: '', run: gatherTagHere, when: inNotebook },
  { group: 'write', label: 'Bring back gathered lines I deleted', keys: '', run: () => notebook.regather(), when: () => inNotebook() && !!notebook.gatherLine() },
  { group: 'write', label: 'Stop gathering on this line', keys: '', run: () => notebook.stopGather(), when: () => inNotebook() && !!notebook.gatherLine() },
  { group: 'write', label: 'Done: strike this line through', keys: `${mod}↵`, run: () => toggleDone(notebook.editor), when: inNotebook },
  { group: 'view', label: 'Keyboard shortcuts (all the keys)', keys: `${mod}/`, run: toggleShortcuts },
  { group: 'page', label: 'Page and text settings', keys: '', run: togglePageSettings },
  { group: 'page', label: 'Wider page', keys: 'Alt+]', run: () => setPage(currentWidth() + 40, currentSize()) },
  { group: 'page', label: 'Narrower page', keys: 'Alt+[', run: () => setPage(currentWidth() - 40, currentSize()) },
  { group: 'page', label: 'Larger text', keys: 'Alt+=', run: () => setPage(currentWidth(), currentSize() + 1) },
  { group: 'page', label: 'Smaller text', keys: 'Alt+−', run: () => setPage(currentWidth(), currentSize() - 1) },
  { group: 'page', label: 'Light / dark', keys: `${mod}⇧L`, run: toggleTheme },
  { group: 'page', label: 'Change the writing font', keys: '', run: cycleFont },
  { group: 'sync', label: 'Sync now', keys: '', run: () => sync.soon(0), when: () => !!sync.user },
  { group: 'sync', label: 'Sign in to sync between devices', keys: '', run: () => sync.signIn(), when: () => sync.available && !sync.user },
  { group: 'sync', label: 'Sign out of sync', keys: '', run: () => sync.signOut(), when: () => !!sync.user },
  { group: 'sync', label: 'Export this chapter as Markdown', keys: '', run: exportChapter, when: () => writing() && !isScript() },
  { group: 'sync', label: 'Export the whole book as Markdown', keys: '', run: exportBook, when: () => writing() && !!state.project && !isScript() },
  { group: 'sync', label: 'Export this script as Fountain', keys: '', run: exportFountain, when: () => writing() && isScript() },
  { group: 'sync', label: 'Back up everything (download all as files)', keys: '', run: exportVault },
  { group: 'sync', label: 'Pictures and files: space used', keys: '', run: showSpace },
  { group: 'write', label: 'Add a picture or file…', keys: '', run: () => setTimeout(pickFiles, 120), when: () => writing() || inNotebook() },
  { group: 'tidy', label: 'Send selection to… a chapter, page or day', keys: '', run: () => setTimeout(sendSelectionPicker, 120), when: () => writing() || inNotebook() },
  { group: 'tidy', label: 'This piece: rename, label, stage, move or trash…', keys: '', run: async () => popMenu(null, await bookMenu(await currentBook()), menuSpot()), when: () => !!currentBookId() },
  { group: 'tidy', label: 'This world: rename, move to an area or trash…', keys: '', run: async () => popMenu(null, await worldMenu(await currentWorld()), menuSpot()), when: () => !!state.worldId && (view() === 'world' || !!currentBookId() || inNotebook()) },
  { group: 'tidy', label: 'Change how this piece is written (prose, script, outline)…', keys: '', run: async () => { const b = await currentBook(); popMenu(null, KINDS.map(([id, label]) => ({ label, current: bookType(b) === id, run: () => setKind(b, id) })), menuSpot()); }, when: () => !!currentBookId() },
  { group: 'new', label: 'New piece in this world (a gag, an episode, a season…)', keys: '', run: async () => { const w = await currentWorld(); if (w) addPiece(w.id); }, when: () => !!state.worldId },
  { group: 'write', label: 'Number the scenes (for production)…', keys: '', run: async () => { const b = await currentBook(); if (!b.fields?.numbered) toggleNumbering(b); }, when: () => writing() && isScript() && !state.project?.fields?.numbered },
  { group: 'write', label: 'Scene numbers: turn off', keys: '', run: async () => toggleNumbering(await currentBook()), when: () => writing() && isScript() && !!state.project?.fields?.numbered },
  { group: 'view', label: 'Show or hide scene numbers', keys: '', run: () => setShown('codes', hidden().has('codes')), when: () => writing() && isScript() },
  { group: 'view', label: 'Plot grid (the story as a table)', keys: `${mod}⇧G`, run: toggleGrid, when: () => view() !== 'grid' && view() !== 'library' },
  { group: 'view', label: 'Back to the text from the grid', keys: `${mod}⇧G`, run: toggleGrid, when: () => view() === 'grid' },
  { group: 'view', label: 'Production (shots, kit, shoot days, posting)', keys: `${mod}⇧S`, run: toggleProduction, when: () => view() !== 'production' && view() !== 'library' },
  { group: 'view', label: 'Back to the text from production', keys: `${mod}⇧S`, run: toggleProduction, when: () => view() === 'production' },
  { group: 'view', label: 'Show or hide section summaries', keys: '', run: () => setShown('synopsis', hidden().has('synopsis')), when: () => writing() && isScript() },
  { group: 'view', label: 'Fresh eyes: a new font, page and colour, to reread it cold', keys: `${mod}⇧Y`, words: ['reread', 'revise', 'unfamiliar'], run: () => toggleFreshEyes() },
  { group: 'view', label: 'Show or hide Claude’s notes in the margin', keys: '', run: () => setShown('claude', hidden().has('claude')) },
  { group: 'view', label: 'Show or hide readers’ comments in the margin', keys: '', run: () => setShown('comments', hidden().has('comments')) },
  { group: 'revise', label: 'Compare drafts, or the text then and now', keys: `${mod}⇧X`, words: ['diff', 'versions', 'changes'], run: toggleCompare, when: () => view() !== 'compare' },
  { group: 'revise', label: 'Back to the text from comparing', keys: `${mod}⇧X`, run: toggleCompare, when: () => view() === 'compare' },
  { group: 'revise', label: 'Read an earlier draft beside this one', keys: `${mod}⇧B`, words: ['side by side', 'old draft'], run: toggleBeside, when: writing },
  { group: 'revise', label: 'Start a new draft from scratch (the old one is kept whole)…', keys: '', words: ['rewrite', 'draft 2'], run: async () => { const b = await revisionPiece(); if (b) newDraft(b); }, when: () => !!currentBookId() },
  { group: 'revise', label: 'Claude’s notes on this chapter (margin notes and a fix list)', keys: '', words: ['feedback', 'editor', 'critique'], run: askClaudeNotes, when: writing },
  { group: 'revise', label: 'Talk this chapter over with Claude', keys: '', words: ['chat', 'conversation', 'feedback'], run: toggleTalk, when: writing },
  { group: 'revise', label: 'Print, or save as PDF (manuscript or screenplay format)', keys: `${mod}P`, words: ['pdf', 'export'], run: printCurrent, when: () => writing() || view() === 'project' || view() === 'compare' || (inNotebook() && notebook.page?.kind === 'page') },
  { group: 'revise', label: 'Share a link to read and comment…', keys: '', words: ['share', 'feedback', 'reader', 'link'], run: () => openShare(), when: () => !!currentBookId() || (inNotebook() && notebook.page?.kind === 'page') },
  { group: 'page', label: 'Name the section levels (Act, Sequence, Scene…)', keys: '', run: nameSectionLevels, when: () => writing() && isScript() },
  { group: 'sync', label: 'Connect Claude to Inkwell (a connector address)…', keys: '', run: () => connectClaude() },
  { group: 'sync', label: 'Connect Scribe, the dictation keyboard…', keys: '', run: () => connectScribe() },
  { group: 'tidy', label: 'This chapter: rename, move or trash…', keys: '', run: async () => popMenu(null, await chapterMenu({ id: state.chapterId }), menuSpot()), when: () => writing() && !!state.chapterId },
  ...Object.entries(LISTS).map(([list, name]) => ({ group: 'page', label: `Make this page a ${name.toLowerCase()} (Claude links each title)`, keys: '', run: () => makeList(list), when: () => inNotebook() && notebook.page?.kind === 'page' && listOf(notebook.page) !== list })),
  { group: 'tidy', label: 'Review the day with Claude (what goes to Daybook, what to keep thinking about)', keys: '', run: () => dayReview.run(), when: () => inNotebook() && notebook.isDay },
  { group: 'new', label: 'Make meeting notes from a recording (summary, decisions, tasks, who said what)…', keys: '', run: () => setTimeout(makeMeeting, 120) },
  { group: 'tidy', label: 'Fix a speaker’s name in this meeting…', keys: '', run: () => setTimeout(fixSpeaker, 120), when: () => inNotebook() && !!notebook.page?.fields?.meeting },
  { group: 'tidy', label: 'Send this line to Daybook (a task in its Inbox, linked back here)', keys: '', run: sendLineToDaybook, when: () => inNotebook() && !!notebook.currentLine() },
  { group: 'page', label: 'Stop Claude linking titles on this page', keys: '', run: () => makeList(null), when: () => inNotebook() && !!listOf(notebook.page) },
  { group: 'tidy', label: 'This page: rename, move to a world or trash…', keys: '', run: async () => popMenu(null, await pageMenu(notebook.page), menuSpot()), when: () => inNotebook() && notebook.page?.kind === 'page' },
  { group: 'tidy', label: 'This area: rename, move or trash…', keys: '', run: async () => popMenu(null, await areaMenu({ id: state.libArea }), menuSpot()), when: () => view() === 'library' && !!state.libArea },
  { group: 'tidy', label: 'Trash: bring things back', keys: '', run: showTrash },
  { group: 'sync', label: 'Two versions to check', urgent: true, keys: '', run: () => conflicts.open(), when: () => !$('#versions').hidden }
];

// The command menu opens on these, so the phone doesn't need a long scroll; typing searches everything.
async function showSpace() {
  const { bytes, count } = await spaceUsed();
  const { count: waiting } = await unsentFiles();
  toast(`Pictures and files: ${mb(bytes)} of ${mb(SPACE)} used · ${count === 1 ? '1 file' : `${count} files`}${waiting ? ` · ${waiting} still to upload from here` : ''}`);
}

// Pictures and files from this device, put in where the caret is.
// ---------- quick inserts (the / menu, Ctrl+Shift+; and Ctrl+;) ----------

const timeNow = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function dayFrom(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function insertTime(ed) { ed.chain().focus().insertContent(`${timeNow()} `).run(); }
// A date is a link to that day's page (made when you first write on it).
function insertDay(ed, n) {
  const id = dayId(isoOf(dayFrom(n)));
  ed.chain().focus().insertContent([{ type: 'entryRef', attrs: { id, title: titleOf({ kind: 'day', id }) } }, { type: 'text', text: ' ' }]).run();
}
// The time on its own line with the caret on a fresh line under it, ready
// for an entry (tucked in a level on the notebook).
function timeHeading(ed) {
  const outline = ed === notebook.editor;
  const empty = !ed.state.selection.$from.parent.textContent.trim();
  const c = ed.chain().focus();
  if (!empty) (outline ? c.splitListItem('listItem') : c.splitBlock());
  c.insertContent(timeNow()).run();
  if (outline) ed.chain().splitListItem('listItem').sinkListItem('listItem').scrollIntoView().run();
  else ed.chain().splitBlock().scrollIntoView().run();
}

setSlashItems((ed) => {
  const outline = ed === notebook.editor;
  const inScript = !outline && isScript();
  const days = WEEKDAYS.map((name, w) => {
    const ahead = ((w - new Date().getDay() + 7) % 7) || 7;
    return { id: name, label: name[0].toUpperCase() + name.slice(1), hint: shortDay(dayFrom(ahead)), more: true, run: (e) => insertDay(e, ahead) };
  });
  return [
    { id: 'time', label: 'Time', hint: timeNow(), keys: '⌘⇧;', run: insertTime },
    { id: 'now', label: 'Time heading', hint: 'a line to write under', words: ['journal', 'entry', 'log'], run: timeHeading },
    { id: 'today', label: 'Today', hint: shortDay(new Date()), keys: '⌘;', words: ['date'], run: (e) => insertDay(e, 0) },
    { id: 'tomorrow', label: 'Tomorrow', hint: shortDay(dayFrom(1)), words: ['date'], run: (e) => insertDay(e, 1) },
    { id: 'yesterday', label: 'Yesterday', hint: shortDay(dayFrom(-1)), words: ['date'], run: (e) => insertDay(e, -1) },
    { id: 'link', label: 'Link to a page', keys: '[[', words: ['page'], run: (e) => openPicker(e) },
    { id: 'tag', label: 'Tag', keys: '#', run: (e) => e.chain().focus().insertContent('#').run() },
    !outline && { id: 'note', label: 'Note on this paragraph', keys: '⌘⇧N', words: ['comment'], run: () => notes.add() },
    !outline && { id: 'talk', label: 'Talk into the draft', hint: 'say it; Claude writes it up', keys: '⌥V', words: ['voice', 'dictate', 'speak', 'record'], run: () => setTimeout(talkIntoDraft, 60) },
    outline && { id: 'talk', label: 'Capture by voice', hint: 'say it; Claude writes it up', keys: '⌥C', words: ['voice', 'dictate', 'speak', 'record'], run: () => setTimeout(() => openCapture(), 60) },
    { id: 'picture', label: 'Picture or file', words: ['image', 'photo', 'file', 'attach'], run: () => setTimeout(pickFiles, 120) },
    outline && { id: 'done', label: 'Done', hint: 'strike the line through', keys: '⌘↵', words: ['todo', 'check'], run: (e) => toggleDone(e) },
    !outline && !inScript && { id: 'scene', label: 'Scene break', keys: '⌘⇧↵', words: ['break', 'divider'], run: (e) => e.chain().focus().insertSceneBreak().run() },
    inScript && { id: 'section', label: 'Section', hint: 'your own heading', words: ['act', 'sequence', 'heading'], run: () => { insertSection(editor.state.selection.$from.before(1)); } },
    ...days
  ].filter(Boolean);
});

function pickFiles() {
  const ed = currentEditor();
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...input.files];
    if (files.length) insertFiles(ed.view, ed.schema.nodes.file, files, null, tooBig);
  });
  input.click();
}

const GROUPS = [
  { id: 'go', label: 'Go', hint: 'Library, today, chapters, back' },
  { id: 'new', label: 'New', hint: 'Book, page, chapter, area' },
  { id: 'write', label: 'Write', hint: 'Links, notes, scene breaks, history' },
  { id: 'view', label: 'View', hint: 'Focus, sidebar, notes, what shows' },
  { id: 'page', label: 'Page and text', hint: 'Width, text size, font, light or dark' },
  { id: 'revise', label: 'Revise and share', hint: 'Compare drafts, new draft, Claude’s notes, print, share a link' },
  { id: 'tidy', label: 'Organize', hint: 'Rename, move, change kind, Trash' },
  { id: 'sync', label: 'Sync and backup', hint: 'Sync, export, back up' }
];

// The piece you're in, wherever you are in it.
function currentBookId() {
  if (view() === 'project') return state.bookId;
  if (view() === 'compare') return state.compareId;
  if (writing()) return state.project?.id || null;
  if (inNotebook() && notebook.page?.kind === 'project') return notebook.page.id;
  return null;
}
const currentBook = () => getEntry(currentBookId());
const currentWorld = () => getEntry(state.worldId);
const menuSpot = () => ({ left: Math.max(8, window.innerWidth / 2 - 130), top: 110 });

async function showTrash() {
  await go({ view: 'library', area: null });
  const box = $('#lib-trash-box');
  if (box.hidden) toast('The Trash is empty');
  else { box.open = true; box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Everything you can go to: books, areas, chapters, pages and recent days.
// Move to…: send the line you're on (and what's under it) to another page or day.
function moveLinePicker() {
  const eid = notebook.currentLine();
  if (!eid || !inNotebook()) return;
  const send = (id, fallback) => async () => {
    if (await notebook.moveLineTo(eid, id, fallback)) statusEl.textContent = (`Moved to ${fallback ? titleOf(fallback) : titleOf(await getEntry(id))}`);
  };
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  openPalette('move', async () => {
    const out = [];
    for (const [label, iso] of [['Today', day(0)], ['Tomorrow', day(1)], ['Yesterday', day(-1)]]) {
      const id = dayId(iso);
      if (id !== notebook.page?.id) out.push({ label, keys: 'day', run: send(id, entry('day', { id, title: iso })) });
    }
    for (const pg of (await byKind('page')).filter((x) => !x.deleted && x.id !== notebook.page?.id).sort((a, c) => c.updated_at - a.updated_at)) out.push({ label: pg.title || 'Untitled page', keys: 'page', run: send(pg.id) });
    const days = (await byKind('day')).filter((d) => !d.deleted && d.id !== notebook.page?.id).sort((a, c) => (a.title < c.title ? 1 : -1)).slice(0, 30);
    for (const d of days) out.push({ label: titleOf(d), keys: 'day', run: send(d.id) });
    return out;
  });
}

// Send selection to…: the paragraphs or lines the selection touches (or the
// one the caret is in) move together to a chapter, page or day.
function selectedIds(ed) {
  const { from, to } = ed.state.selection;
  const ids = [];
  ed.state.doc.descendants((node, pos) => {
    if (pos + node.nodeSize < from || pos > to) return false;
    if (node.attrs?.eid && (node.type.name === 'listItem' || node.isBlock)) { ids.push(node.attrs.eid); return false; }
    return true;
  });
  return ids;
}

// ids: the paragraphs or lines to send (the six-dot menu passes its own one).
function sendSelectionPicker(ids = selectedIds(currentEditor())) {
  if (!ids.length) return;
  const here = inNotebook() ? notebook.page?.id : state.chapterId;
  const send = (id, fallback) => async () => {
    const n = await moveEntries(ids, id, { fallback });
    if (n) statusEl.textContent = `Moved ${n === 1 ? '' : `${n} `}to ${fallback ? titleOf(fallback) : titleOf(await getEntry(id))}`;
  };
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  openPalette('move', async () => {
    const out = [];
    for (const [label, iso] of [['Today', day(0)], ['Tomorrow', day(1)], ['Yesterday', day(-1)]]) {
      const id = dayId(iso);
      if (id !== here) out.push({ label, keys: 'day', run: send(id, entry('day', { id, title: iso })) });
    }
    for (const ch of (await byKind('chapter')).filter((x) => !gone(x) && x.id !== here).sort((a, c) => c.updated_at - a.updated_at)) {
      const book = await bookOf(ch);
      if (book && !gone(book)) out.push({ label: `${ch.title || 'Untitled'} · ${book.title || 'Untitled'}`, keys: 'chapter', run: send(ch.id) });
    }
    for (const pg of (await byKind('page')).filter((x) => !gone(x) && x.id !== here).sort((a, c) => c.updated_at - a.updated_at)) out.push({ label: pg.title || 'Untitled page', keys: 'page', run: send(pg.id) });
    for (const d of (await byKind('day')).filter((x) => !x.deleted && x.id !== here).sort((a, c) => (a.title < c.title ? 1 : -1)).slice(0, 30)) out.push({ label: titleOf(d), keys: 'day', run: send(d.id) });
    return out;
  });
}

// Gather a tag: pick the page its lines should gather on (from the tag's list).
function gatherOntoPage(tag) {
  if (!tag) return;
  $('.tag-results').hidden = true;
  const onto = (pageId) => async () => {
    await go({ view: 'notebook', pageId });
    const n = await notebook.addGather(tag);
    statusEl.textContent = n ? `Gathered ${n} #${tag} ${n === 1 ? 'line' : 'lines'}` : `Gathering #${tag} here`;
  };
  openPalette('pick', async () => {
    const out = [];
    if (notebook.page && !notebook.isDay) out.push({ label: `This page: ${titleOf(notebook.page)}`, keys: 'page', run: onto(notebook.page.id) });
    const label = tag.charAt(0).toUpperCase() + tag.slice(1).replace(/[-_]/g, ' ');
    out.push({ label: `A new page called “${label}”`, keys: 'new', run: async () => {
      const world = notebook.page && !notebook.isDay ? await worldOf(notebook.page) : null;
      const page = await newPage(world?.id || (view() === 'project' ? state.bookId : null), label);
      await onto(page.id)();
    } });
    for (const pg of (await byKind('page')).filter((x) => !x.deleted && x.id !== notebook.page?.id).sort((a, c) => c.updated_at - a.updated_at)) out.push({ label: pg.title || 'Untitled page', keys: 'page', run: onto(pg.id) });
    return out;
  }, `Gather #${tag} onto which page?`);
}

// Gather a tag onto the page you're on: pick the tag.
function gatherTagHere() {
  openPalette('pick', async () => {
    const tags = new Map();
    for (const kind of ['line', 'para']) for (const r of await byKind(kind)) for (const t of r.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    return [...tags].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ label: `#${t}`, keys: String(n), run: async () => {
      const added = await notebook.addGather(t);
      statusEl.textContent = added ? `Gathered ${added} #${t} ${added === 1 ? 'line' : 'lines'}` : `Gathering #${t} here`;
    } }));
  }, 'Gather which #tag onto this page?');
}

async function places(only) {
  const [allAreas, allBooks, allWorlds] = await Promise.all([areas(), books(), worlds()]);
  const out = [];
  const worldName = new Map(allWorlds.map((w) => [w.id, w.title || 'Untitled']));
  for (const w of allWorlds.sort((a, c) => c.updated_at - a.updated_at)) out.push({ label: w.title || 'Untitled', keys: 'world', run: () => go({ view: 'world', id: w.id }) });
  for (const b of allBooks.sort((a, c) => c.updated_at - a.updated_at)) {
    const w = worldName.get(b.parent_id);
    // A world's only piece of the same name is already listed as the world.
    if (w === (b.title || 'Untitled') && allBooks.filter((x) => x.parent_id === b.parent_id).length === 1) continue;
    out.push({ label: w ? `${b.title || 'Untitled'} · ${w}` : b.title || 'Untitled', keys: kindName(b).toLowerCase(), run: () => go({ view: 'project', id: b.id }) });
  }
  if (only === 'books') return out;
  for (const a of allAreas) out.push({ label: a.title, keys: 'area', run: () => go({ view: 'library', area: a.id }) });
  // Every act and chapter in two reads, rather than a read per book and act.
  const [allActs, allChapters] = await Promise.all([byKind('act'), byKind('chapter')]);
  const under = new Map();
  for (const r of [...allActs, ...allChapters]) (under.get(r.parent_id) || under.set(r.parent_id, []).get(r.parent_id)).push(r);
  const inOrder = (id) => (under.get(id) || []).sort(bySort);
  for (const b of allBooks.filter(hasManuscript)) {
    for (const act of inOrder(b.id)) if (act.kind === 'act') for (const ch of inOrder(act.id)) out.push({ label: `${ch.title} · ${b.title}`, keys: 'chapter', run: () => go({ view: 'write', chapterId: ch.id }) });
  }
  for (const p of (await byKind('page')).filter((x) => !x.deleted)) out.push({ label: p.title || 'Untitled page', keys: 'page', run: () => go({ view: 'notebook', pageId: p.id }) });
  const days = (await byKind('day')).filter((d) => !d.deleted).sort((a, c) => (a.title < c.title ? 1 : -1)).slice(0, 30);
  for (const d of days) out.push({ label: titleOf(d), keys: 'day', run: () => go({ view: 'notebook', pageId: d.id }) });
  return out;
}

let paletteIndex = 0;
let paletteItems = [];
let paletteMode = 'commands';
let paletteSource = commands;
let paletteReady = Promise.resolve();
let paletteGroup = null;
let searchIdx = null;
const KIND_LABEL = { para: 'text', heading: 'heading', line: 'line', note: 'note', scene: 'scene', project: 'book', chapter: 'chapter', page: 'page', area: 'area' };

// A search result: open it where it lives, with the caret on it.
async function openHit(row) {
  if (row.kind === 'note') { await openEntry(row.parent_id); if (!notes.visible) notes.setVisible(true); return; }
  if (row.kind === 'chapter') return go({ view: 'write', chapterId: row.id });
  return openEntry(row.id);
}

async function openPalette(mode = 'commands', only, placeholder) {
  // Open and focus at once so nothing typed is lost; the list fills in after.
  paletteMode = mode;
  paletteGroup = null;
  const listed = mode === 'move' || mode === 'pick';
  paletteSource = mode === 'go' || listed || mode === 'search' ? [] : commands;
  paletteReady = Promise.resolve();
  $('.palette').hidden = false;
  $('.palette-backdrop').hidden = false;
  const input = $('#palette-input');
  input.placeholder = mode === 'pick' ? placeholder : mode === 'search' ? 'Search all your writing…' : mode === 'move' ? 'Move this line to…' : mode === 'go' ? (only === 'books' ? 'Go to a book…' : 'Go to a book, chapter, page or day…') : 'Type a command…';
  input.value = typeof only === 'string' && mode === 'search' ? only : '';
  input.focus();
  filterPalette();
  if (mode === 'search') {
    // Stores what's written now; each search after that is instant.
    searchIdx = null;
    paletteReady = (async () => { await store.close(editor.state.doc); await notebook.close(); return searchIndex(); })().then((idx) => {
      if (paletteMode !== 'search') return;
      searchIdx = idx;
      filterPalette();
    });
    await paletteReady;
  }
  if (mode === 'go' || listed) {
    paletteReady = (listed ? only() : places(only)).then((list) => {
      if (paletteMode !== mode) return;
      paletteSource = list;
      filterPalette();
    });
    await paletteReady;
  }
}

function closePalette(refocus = true) {
  $('.palette').hidden = true;
  $('.palette-backdrop').hidden = true;
  if (refocus && (writing() || inNotebook())) currentEditor().commands.focus();
}

function openGroup(id) {
  paletteGroup = id;
  const input = $('#palette-input');
  input.placeholder = id ? `${GROUPS.find((g) => g.id === id).label}…` : 'Type a command…';
  input.value = '';
  input.focus();
  filterPalette();
}

function filterPalette() {
  const q = $('#palette-input').value.trim().toLowerCase();
  const usable = (c) => !c.when || c.when();
  if (paletteMode === 'commands' && !q && !paletteGroup) {
    // Anything waiting on you stays at the top; then the categories.
    paletteItems = [
      ...commands.filter((c) => c.urgent && usable(c)),
      ...GROUPS.map((g) => ({ label: g.label, hint: g.hint, keys: '›', stay: true, run: () => openGroup(g.id) })),
      { label: 'Keyboard shortcuts', hint: 'Every key, named for this computer', keys: `${mod}/`, run: toggleShortcuts }
    ];
  } else if (paletteMode === 'commands' && !q) {
    paletteItems = [
      { label: '‹ All commands', keys: '', stay: true, back: true, run: () => openGroup(null) },
      ...commands.filter((c) => c.group === paletteGroup && usable(c))
    ];
  } else if (paletteMode === 'search') {
    const raw = $('#palette-input').value;
    const hits = searchIdx ? searchIdx.find(raw) : [];
    paletteItems = hits.map((h) => ({ label: h.snippet, hint: h.where, keys: KIND_LABEL[h.row.kind] || '', run: () => openHit(h.row) }));
    if (!paletteItems.length) {
      const note = !searchIdx ? 'Looking…' : raw.trim().length < 2 ? 'Type a word or two from anything you’ve written' : 'Nothing found';
      paletteItems = [{ label: note, keys: '', stay: true, run: () => {} }];
    }
  } else {
    const inGroup = (c) => !paletteGroup || paletteMode !== 'commands' || c.group === paletteGroup;
    // Best matches first: the whole name, then names starting with it, then a
    // word starting with it, then anywhere (so "Page 3" isn't lost behind "Page 30").
    const rank = (label) => {
      const l = label.toLowerCase();
      if (l === q) return 0;
      if (l.startsWith(q)) return l[q.length] === ' ' ? 1 : 2;
      return l.includes(` ${q}`) ? 3 : 4;
    };
    paletteItems = paletteSource.filter((c) => usable(c) && inGroup(c) && c.label.toLowerCase().includes(q))
      .map((c, i) => ({ c, i, r: q ? rank(c.label) : 0 })).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 60).map((x) => x.c);
    // Not a title? Offer to look inside the writing too.
    if (paletteMode === 'go' && q.length > 1) {
      const text = $('#palette-input').value.trim();
      paletteItems.push({ label: `Search inside your writing for “${text}”`, keys: `${mod}⇧F`, stay: true, run: () => openPalette('search', text) });
    }
  }
  // In a category, start on its first command rather than the way back.
  paletteIndex = paletteItems[0]?.back && paletteItems.length > 1 ? 1 : 0;
  const list = $('#palette-list');
  list.replaceChildren();
  paletteItems.forEach((c, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === paletteIndex));
    li.innerHTML = '<span class="label"></span><span class="keys"></span>';
    li.firstChild.textContent = c.label;
    if (c.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = c.hint; li.firstChild.append(h); }
    if (c.back) li.classList.add('back');
    if (c.stay) li.classList.add('opens');
    // While searching, say which category a command without a shortcut lives in.
    li.lastChild.textContent = keyLabel(c.keys) || (q && c.group ? GROUPS.find((g) => g.id === c.group).label : '');
    li.addEventListener('click', () => runCommand(c));
    li.addEventListener('mousemove', () => selectPalette(i));
    list.append(li);
  });
}

function selectPalette(i) {
  paletteIndex = i;
  [...$('#palette-list').children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
  $('#palette-list').children[i]?.scrollIntoView({ block: 'nearest' });
}

function runCommand(c) {
  if (c.stay) return c.run();
  closePalette(paletteMode !== 'go');
  c.run();
}

$('#palette-input').addEventListener('input', filterPalette);
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selectPalette(Math.min(paletteIndex + 1, paletteItems.length - 1)); }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectPalette(Math.max(paletteIndex - 1, 0)); }
  if (e.key === 'Enter') {
    e.preventDefault();
    // Enter pressed before the list arrived still picks the best match.
    paletteReady.then(() => { if (paletteItems[paletteIndex]) runCommand(paletteItems[paletteIndex]); });
  }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (paletteGroup && !e.target.value) openGroup(null); else closePalette(); }
  if (e.key === 'Backspace' && paletteGroup && !e.target.value) { e.preventDefault(); openGroup(null); }
  if (e.key === 'ArrowRight' && !e.target.value && paletteItems[paletteIndex]?.stay && !paletteItems[paletteIndex].back) { e.preventDefault(); runCommand(paletteItems[paletteIndex]); }
  if (e.key === 'ArrowLeft' && !e.target.value && paletteGroup) { e.preventDefault(); openGroup(null); }
});
$('.palette-backdrop').addEventListener('click', () => closePalette());

function toggleNotes() {
  notes.setVisible(!notes.visible);
}
document.addEventListener('notes-visibility', () => { $('#notes-toggle').textContent = notes.visible ? 'Hide notes' : 'Notes'; });

const toggleWriteToday = () => go(inNotebook() ? { view: 'write' } : { view: 'notebook', pageId: dayId(isoToday()) });

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  const cmd = b.dataset.cmd;
  if (cmd === 'palette') openPalette();
  if (cmd === 'notes') toggleNotes();
  if (cmd === 'page') togglePageSettings();
  if (cmd === 'history') openHistory();
  if (cmd === 'new-chapter') newChapter();
  if (cmd === 'new-act') newAct();
  if (cmd === 'new-page') newPageHere();
  if (cmd === 'view') toggleWriteToday();
  if (cmd === 'focus') toggleFocus();
  if (cmd === 'shortcuts') toggleShortcuts();
  if (cmd === 'stats') progressPanel.toggle();
  if (cmd === 'library') go({ view: 'library', area: null });
  if (cmd === 'grid') toggleGrid();
  if (cmd === 'production') toggleProduction();
  if (cmd === 'today') go({ view: 'notebook', pageId: dayId(isoToday()) });
  if (cmd === 'gather-tag') gatherOntoPage(notebook.shownTag);
  if (cmd === 'tags') go({ view: 'tags' });
  if (cmd === 'close-tag') { $('.tag-results').hidden = true; currentEditor().commands.focus(); }
});

document.addEventListener('keydown', (e) => {
  const m = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (m && k === 'k') { e.preventDefault(); $('.palette').hidden ? openPalette() : closePalette(); }
  else if (m && e.key === '.') { e.preventDefault(); toggleFocus(); }
  else if (m && e.shiftKey && k === 'f') { e.preventDefault(); openPalette('search'); }
  else if (m && e.shiftKey && k === 'o') { e.preventDefault(); go({ view: 'library', area: null }); }
  else if (m && k === 'o') { e.preventDefault(); openPalette('go'); }
  else if (m && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
  else if (m && !e.shiftKey && !e.altKey && e.code === 'BracketLeft') { e.preventDefault(); history.back(); }
  else if (m && !e.shiftKey && !e.altKey && e.code === 'BracketRight') { e.preventDefault(); history.forward(); }
  else if (m && !e.altKey && e.code === 'Semicolon' && (writing() || inNotebook()) && currentEditor().isFocused) { e.preventDefault(); if (e.shiftKey) insertTime(currentEditor()); else insertDay(currentEditor(), 0); }
  else if (m && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); toggleShortcuts(); }
  else if (m && e.shiftKey && k === 'p') { e.preventDefault(); progressPanel.toggle(); }
  else if (m && k === 'j') { e.preventDefault(); toggleWriteToday(); }
  else if (m && k === '1') { e.preventDefault(); body.classList.toggle('pin-outline'); }
  else if (m && k === '2' && writing()) { e.preventDefault(); toggleNotes(); }
  else if (((m && e.shiftKey) || (!isMac && e.altKey && !m && !e.shiftKey)) && e.code === 'KeyN' && writing()) { e.preventDefault(); notes.add(); }
  else if (e.altKey && e.shiftKey && !m && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && writing() && editor.isFocused) { e.preventDefault(); blocks.moveCurrent(e.key === 'ArrowUp' ? -1 : 1); }
  else if (m && e.shiftKey && k === 'e' && writing()) { e.preventDefault(); editor.commands.focus(); alts.toggle({ scope: 'word', focusAdd: true }); }
  else if (m && e.shiftKey && k === 'd' && writing() && editor.isFocused) { e.preventDefault(); newParagraphVersion(editor); }
  else if (e.altKey && !e.shiftKey && !m && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && writing() && editor.isFocused) { if (flip(editor, e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault(); }
  else if (m && e.shiftKey && k === 'h' && (writing() || inNotebook())) { e.preventDefault(); openHistory(); }
  else if (m && e.shiftKey && k === 'l') { e.preventDefault(); toggleTheme(); }
  else if (m && e.shiftKey && k === 'g') { e.preventDefault(); toggleGrid(); }
  else if (m && e.shiftKey && !e.altKey && k === 's') { e.preventDefault(); toggleProduction(); }
  else if (m && e.shiftKey && !e.altKey && k === 'y') { e.preventDefault(); toggleFreshEyes(); }
  else if (m && e.shiftKey && !e.altKey && k === 'x') { e.preventDefault(); toggleCompare(); }
  else if (m && !e.shiftKey && !e.altKey && k === 'p' && (writing() || view() === 'project' || view() === 'compare' || (inNotebook() && notebook.page?.kind === 'page'))) { e.preventDefault(); printCurrent(); }
  // Alt+C: Capture, recording at once; Alt+C again keeps it.
  else if (e.altKey && !m && !e.shiftKey && e.code === 'KeyV' && (writing() || capture.isOpen)) { e.preventDefault(); if (!capture.isOpen) talkIntoDraft(); else if (capture.rec) capture.finish(); }
  else if (e.altKey && !m && !e.shiftKey && e.code === 'KeyC') { e.preventDefault(); if (!capture.isOpen) openCapture({ start: true }); else if (capture.rec) capture.finish(); }
  else if (e.altKey && !m && e.code === 'BracketRight') { e.preventDefault(); setPage(currentWidth() + 40, currentSize()); }
  else if (e.altKey && !m && e.code === 'BracketLeft') { e.preventDefault(); setPage(currentWidth() - 40, currentSize()); }
  else if (e.altKey && !m && e.code === 'Equal') { e.preventDefault(); setPage(currentWidth(), currentSize() + 1); }
  else if (e.altKey && !m && e.code === 'Minus') { e.preventDefault(); setPage(currentWidth(), currentSize() - 1); }
  else if (e.key === 'Escape' && root.classList.contains('reading')) toggleReading();
  else if (e.key === 'Escape') {
    if (alts.isOpen) alts.close();
    if (!$('.page-settings').hidden) { $('.page-settings').hidden = true; currentEditor().commands.focus(); }
    if (!$('.history').hidden) closeHistory();
    if (!$('.tag-results').hidden) { $('.tag-results').hidden = true; currentEditor().commands.focus(); }
    if (!$('.versions').hidden) conflicts.close();
    if (!$('.shortcuts').hidden) toggleShortcuts();
    if (progressPanel.isOpen) progressPanel.close();
    body.classList.remove('show-outline', 'show-top');
  }
});

// Save before the tab goes away.
document.addEventListener('visibilitychange', () => { if (document.hidden) { store.close(editor.state.doc); notebook.close(); } });
window.addEventListener('pagehide', () => { store.close(editor.state.doc); notebook.close(); });

// ---------- capture: talk, and it lands on today's page ----------

const askServer = (body) => (window.__claude ? window.__claude(body) : sync.invoke('inkwell', body));
const canAskServer = () => !!window.__claude || (!!sync.user && navigator.onLine && !!sync.backend?.invoke);
// Until writing-out is set up, the recording's chip says so; nothing else nags.
function writeOut() {
  const opts = { ask: askServer, canAsk: canAskServer, onRows: (rows) => applyRemote(rows) };
  return Promise.all([writeOutPending({ ...opts, draft: { context: draftContext, deliver: deliverDraft } }), snapshotPending(opts), meetingPending({ ...opts, ...meetingOpts }), sendPending({ send: sendTask, canSend: canSendTask })]);
}
// Meetings: your tasks go to Daybook in the meeting's area (Business, Filmmaking).
const daybookAreas = () => (window.__areas ? window.__areas() : sync.user && sync.backend?.areas ? sync.backend.areas() : null);
const meetingOpts = {
  me: () => sync.user?.user_metadata?.full_name || sync.user?.user_metadata?.name || '',
  areas: daybookAreas,
  base: () => location.origin + location.pathname,
  sendPending: () => sendPending({ send: sendTask, canSend: canSendTask }),
  onDone: (it, notes) => {
    const sent = notes.tasks.filter((t) => mine(t.owner, meetingOpts.me())).length;
    toast(`Meeting notes ready: ${notes.title}${sent ? ` (${sent} task${sent === 1 ? '' : 's'} to Daybook)` : ''}`, { label: 'Open', run: () => openEntry(`pg_meet-${it.file}`) });
  }
};
// Ctrl+K: the recording on this line becomes a meeting, or pick a recording file.
async function makeMeeting() {
  const id = inNotebook() ? notebook.currentLine() : null;
  const line = id ? await getEntry(id) : null;
  if (audioOn(line)) {
    await notebook.close();
    await meetingFromLine(line.id);
    toast(canAskServer() ? 'Writing out the meeting…' : 'It’ll be written out once you’re online and signed in');
    writeOut();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await Promise.all([store.close(editor.state.doc), notebook.close()]);
    const added = await addMeetingFile(file);
    if (!added) { toast(`“${file.name}” is over ${Math.round(MAX_BYTES / 1048576)} MB. In Voice Recorder, set Recording quality lower and record again`); return; }
    await applyRemote(added.rows);
    await go({ view: 'notebook', pageId: added.line.parent_id, line: added.line.id });
    toast(canAskServer() ? 'Writing out the meeting…' : 'It’ll be written out once you’re online and signed in');
    writeOut();
  });
  input.click();
}
async function fixSpeaker() {
  const pid = notebook.page?.id;
  const names = await speakersOn(pid);
  popMenu(null, names.map((from) => ({ label: from, run: async () => {
    const to = await askText({ title: `Rename ${from}`, body: 'Every line they said gets the new name.', value: from, ok: 'Rename' });
    if (!to || to === from) return;
    await notebook.close();
    await applyRemote(await renameSpeaker(pid, from, to));
  } })), menuSpot());
}
// Send a line to Daybook, as a task in its Inbox that links back here.
const sendTask = (task) => (window.__daybook ? window.__daybook(task) : sync.backend.addTask(task));
const canSendTask = () => !!window.__daybook || (!!sync.user && navigator.onLine && !!sync.backend?.addTask);
async function sendLineToDaybook() {
  const id = notebook.currentLine();
  if (!id) return;
  await notebook.close();
  const row = await sendToDaybook(id, location.origin + location.pathname);
  if (!row) { toast('Write something on the line first'); return; }
  await applyRemote([row]);
  const sent = await sendPending({ send: sendTask, canSend: canSendTask });
  toast(sent ? 'Sent to Daybook’s Inbox' : 'It’ll go to Daybook’s Inbox once you’re online and signed in');
}
// A link from Daybook (or anywhere) to ?open=<id> opens that line where it
// lives, once this device has it.
let asking = null;
async function openAsked() {
  if (!asking) return;
  const row = await getEntry(asking);
  if (!row) return;
  asking = null;
  openEntry(row.id);
}
// Things shared into Inkwell from other apps land on today's page, with the
// caret on the empty line under the last one, for what it sparked.
let landing = null;
function landShares() {
  landing ||= landSharesNow().finally(() => { landing = null; });
  return landing;
}
async function landSharesNow() {
  const skipped = [];
  const added = await takeShares(skipped).catch((e) => { console.error(e); return []; });
  if (skipped.length) toast(`“${skipped[0]}” is over ${Math.round(MAX_BYTES / 1048576)} MB, too big to keep. For meetings, set Voice Recorder’s Recording quality lower`);
  if (!added.length) return;
  await Promise.all([store.close(editor.state.doc), notebook.close()]);
  await applyRemote(added.flatMap((a) => a.rows));
  const last = added.at(-1);
  await go({ view: 'notebook', pageId: last.line.parent_id, line: last.spark.id });
  toast(added.length === 1 ? 'Kept on today’s page' : `${added.length} things kept on today’s page`);
  writeOut();
}
// Lands a capture on today's page and shows it there.
async function showCapture({ line, rows }) {
  await applyRemote(rows);
  await go({ view: 'notebook', pageId: line.parent_id, line: line.id });
  writeOut();
}
const capture = new CaptureScreen($('.capture'), {
  onSaved: (saved) => {
    // Aimed at the draft: you stay where you were writing, and the words follow.
    if (saved.line.fields?.into) { toast('Kept. Claude is writing it into the draft…'); applyRemote(saved.rows).then(() => { if (writing()) editor.commands.focus(); writeOut(); }); return; }
    toast('Kept on today’s page');
    showCapture(saved);
  },
  onClose: () => currentEditor().commands.focus(),
  toast
});
// ---------- walk and talk: say it, and Claude writes it into the draft ----------

// Opens Capture aimed at the chapter you're in, just after the paragraph the caret is on.
async function talkIntoDraft() {
  if (!writing() || !state.chapterId) { openCapture(); return; }
  await openCapture({ start: true, into: await draftSpot() });
}
async function draftSpot() {
  const chapter = await getEntry(state.chapterId);
  const block = editor.state.selection.$from.node(1);
  return { chapter: state.chapterId, title: chapter?.title || 'this chapter', after: block?.attrs.eid || null };
}
// Picks a recording file for Capture, or for the draft you're in.
async function fromRecordingFile(draft) {
  // The file picker needs this tap, so it opens first and Capture follows.
  const into = draft && writing() && state.chapterId ? await draftSpot() : null;
  await openCapture({ start: false, into });
  capture.pick.click();
}
// What Claude needs to know about where the words go: the text just before,
// whether it's a script, and what's being written.
async function draftContext(into) {
  const chapter = await getEntry(into.chapter);
  if (!chapter) return {};
  const book = await bookOf(chapter);
  const kids = (await children(chapter.id)).filter((k) => k.kind === 'para' || k.kind === 'heading').sort((a, b) => a.sort - b.sort);
  const at = kids.findIndex((k) => k.id === into.after);
  const before = kids.slice(0, at >= 0 ? at + 1 : kids.length).map((k) => (k.text || '').trim()).filter(Boolean).join('\n\n').slice(-3000);
  return { before, script: !!book && bookType(book) === 'screenplay', book: [book?.title, chapter.title].filter(Boolean).join(', ') };
}
// The words land in the chapter (an open one is saved first, then refreshed).
// If the chapter's gone, they land on the day page like any capture.
async function deliverDraft(it, answer) {
  if (state.chapterId === it.into.chapter) await store.flush(editor.state.doc);
  const { script } = await draftContext(it.into);
  const types = await noteTypes();
  const rows = await placeDraft({ ...it.into, line: it.line }, answer, { script, noteType: types[0]?.id || null });
  const line = await getEntry(it.line);
  const raw = String(answer.raw || '').trim();
  if (rows === null) return placeVoice(it, answer, {});
  if (line && raw) {
    const kept = { ...line, fields: { ...line.fields, voice: { raw, mode: answer.mode || 'scene', into: it.into.chapter } }, updated_at: Date.now() };
    await putEntries([kept]);
    rows.push(kept);
  }
  const first = rows.find((r) => r.kind === 'para');
  // Still on the spot you talked into: carry on writing after what you said.
  const here = state.chapterId === it.into.chapter && editor.state.selection.$from.node(1)?.attrs.eid;
  if (here && (here === it.into.after || !it.into.after)) caretAfter = rows.filter((r) => r.kind === 'para' && !r.deleted && r.fields?.voice).at(-1)?.id || null;
  if (first) toast(`Your words are in “${it.into.title || 'the draft'}”`, state.chapterId === it.into.chapter ? null : { label: 'Show', run: () => openEntry(first.id) });
  else if (raw === '') toast('Nothing was heard in that recording');
  return rows;
}

// A tap on a capture's mode chip: the same words in another mode, or word for word.
onVoiceChip(async (lineId, chip) => {
  const info = await voiceInfo(lineId);
  if (!info) return;
  const modes = await knownModes();
  if (canAskServer()) fetchModes(askServer).catch(() => {});
  const use = (id, name) => async () => {
    if (id === info.mode) return;
    if (!info.made.includes(id) && !canAskServer()) { toast('Writing it up another way needs a connection'); return; }
    await notebook.close();
    if (!info.made.includes(id)) toast(`Writing it up as ${name}…`);
    try {
      await applyRemote(await switchVoice(lineId, id, askServer));
    } catch (e) { console.error(e); toast(e.message || 'Claude couldn’t write it up that way this time'); }
  };
  popMenu(chip, [
    { label: 'Word for word', current: info.mode === RAW, run: use(RAW, 'Word for word') },
    ...modes.map((m) => ({ label: m.name, current: info.mode === m.id, run: use(m.id, m.name) })),
    'sep',
    { label: 'Copy this version', run: async () => { await notebook.close(); const t = await voiceText(lineId); try { await navigator.clipboard.writeText(t); toast('Copied, ready to paste'); } catch { showCopy({ title: 'Copy this version', value: t }); } } },
    { label: 'Change your modes…', run: () => openModes() }
  ]);
});

// Your modes, the same ones Scribe uses: rename one, change what it does or
// which Claude writes it, add one, or delete one.
async function openModes(anchor = $('.corner [data-cmd="palette"]')) {
  if (!canAskServer()) { toast('Your modes live on your account; sign in and get online to change them'); return; }
  let modes;
  try { modes = await fetchModes(askServer); } catch { toast('Couldn’t reach your modes. Try again.'); return; }
  const save = async (item) => {
    try {
      const out = await askServer({ mode: 'voice-save-mode', item });
      if (out?.error) throw new Error(out.error);
      await fetchModes(askServer);
      toast(`Saved “${item.name}”. Scribe has it too.`);
    } catch (e) { toast(e.message || 'Couldn’t save that mode. Try again.'); }
  };
  const CLAUDES = [['haiku', 'Haiku: quick, for light jobs'], ['sonnet', 'Sonnet: everyday writing'], ['opus', 'Opus: when the writing matters']];
  popMenu(anchor, [
    { note: 'Your modes, shared with Scribe' },
    ...modes.map((m) => ({ label: m.name, sub: [
      { label: 'Rename…', run: async () => { const name = await askText({ title: 'Rename this mode', value: m.name }); if (name && name !== m.name) save({ ...m, name }); } },
      { label: 'What it does…', run: async () => { const prompt = await askText({ title: `What ${m.name} does`, body: 'In plain words, how what you say gets written up.', value: m.prompt || '' }); if (prompt !== null && prompt !== m.prompt) save({ ...m, prompt }); } },
      { label: 'Which Claude writes it', sub: CLAUDES.map(([id, label]) => ({ label, current: m.model === id, run: () => save({ ...m, model: id }) })) },
      'sep',
      { label: 'Delete', danger: true, run: async () => {
        if (!(await ask({ title: `Delete “${m.name}”?`, body: 'It goes from Scribe too. Anything already written up with it stays as it is.', ok: 'Delete', danger: true }))) return;
        const out = await askServer({ mode: 'voice-delete-mode', id: m.id }).catch((e) => ({ error: e.message }));
        if (out?.error) { toast(out.error); return; }
        await fetchModes(askServer);
        toast(`Deleted “${m.name}”`);
      } }
    ] })),
    'sep',
    { label: 'New mode…', run: async () => {
      const name = await askText({ title: 'New mode', placeholder: 'Like “Pitch” or “Lyrics”', ok: 'Next' });
      if (!name) return;
      const prompt = await askText({ title: `What ${name} does`, body: 'In plain words, how what you say gets written up.', ok: 'Add' });
      if (prompt) save({ name, prompt, model: 'opus' });
    } }
  ]);
}

async function openCapture(opts) {
  if (!$('.palette').hidden) closePalette(false);
  // Anything typed is saved first, so the new line can't clash with it.
  await Promise.all([store.close(editor.state.doc), notebook.close()]);
  capture.show(opts);
}
window.addEventListener('online', () => writeOut());

// The day review: Claude sums up a day's page and sorts what's on it, and you
// decide each thing (Daybook, keep thinking, split, let go).
dayReview = new DayReview($('.day-review'), {
  ask: askServer,
  canAsk: canAskServer,
  areas: () => (window.__areas ? window.__areas() : sync.user && sync.backend?.areas ? sync.backend.areas() : null),
  sendPending: () => sendPending({ send: sendTask, canSend: canSendTask }),
  base: () => location.origin + location.pathname,
  onRows: (rows) => applyRemote(rows),
  onOpen: (id) => openEntry(id),
  toast
});
// The Tags page: every tag, grouped, merged and gone through one by one.
tagsPage = new TagsPage({
  sheet: $('#tags-sheet'),
  go: async (place, { replace = false } = {}) => {
    const mode = historyMode;
    if (replace) historyMode = 'replace';
    try { await go(place); } finally { historyMode = mode; }
  },
  open: (id) => openEntry(id),
  ask: askServer,
  canAsk: canAskServer,
  changed: (rows) => applyRemote(rows),
  toast
});
// The 9 pm note in Daybook links to ?review=<date>: open that day and its
// review, or ask Claude for one once this device has caught up.
let reviewing = null;
async function reviewAsked() {
  if (!reviewing) return;
  const iso = reviewing;
  if (!inNotebook() || notebook.page?.id !== dayId(iso)) await go({ view: 'notebook', pageId: dayId(iso) });
  if (await getReview(iso)) { reviewing = null; await dayReview.reveal(); return; }
  if (!canAskServer()) return;
  reviewing = null;
  await dayReview.run(iso);
  dayReview.box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Watch and read lists: once typing pauses, Claude links the titles you've
// moved on from (never the line you're on).
let listTimer;
function listSoon(ms = 4000) {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    if (!inNotebook() || !listOf(notebook.page)) return;
    fillList(notebook.page, { ask: askServer, canAsk: canAskServer, onRows: (rows) => applyRemote(rows), skip: notebook.editor.isFocused ? notebook.currentLine() : null });
  }, ms);
}
async function makeList(list) {
  if (!notebook.page) return;
  await notebook.close();
  const page = await setList(notebook.page.id, list);
  if (!page) return;
  notebook.page = notebook.store.page = page;
  toast(list ? `Claude will link each title on this ${LISTS[list].toLowerCase()}` : 'Claude won’t link titles on this page');
  listSoon(500);
}
// Sharing again while Inkwell is already open brings it to the front.
document.addEventListener('visibilitychange', () => { if (!document.hidden) landShares(); });

// ---------- start ----------

async function start() {
  if (localStorage.getItem('font')) setFont(localStorage.getItem('font'));
  await ensureSeed();
  await ensureAreas();
  // If sync never answers (no signal, say), books still become worlds.
  setTimeout(migrateOnce, 6000);
  let place = null;
  try { place = JSON.parse(localStorage.getItem('place') || 'null'); } catch { /* ignore */ }
  if (!place?.view) place = { view: 'write' };
  // A daily page opens to today; anything else opens where you left it.
  if (place.view === 'notebook' && (!place.pageId || place.pageId.startsWith('day-'))) place = { view: 'notebook', pageId: dayId(isoToday()) };
  if (place.view === 'notebook') { const p = await getEntry(place.pageId); if (!place.pageId.startsWith('day-') && gone(p)) place = { view: 'notebook', pageId: dayId(isoToday()) }; }
  if (place.view === 'project' || place.view === 'world') { const b = await getEntry(place.id); if (gone(b)) place = { view: 'library' }; }
  if (place.view === 'write' && place.chapterId) { const c = await getEntry(place.chapterId); if (gone(c)) place = { view: 'write' }; }
  if (place.view !== 'write') delete root.dataset.view;
  await go(place);
  historyMode = 'push';
  // A recording cut short (the app closed, the phone died) is kept, not lost.
  const recovered = await recoverRecording().catch((e) => { console.error(e); return null; });
  if (recovered) { toast('A recording that was cut short is kept on today’s page'); await showCapture(recovered); }
  // The home-screen shortcut (long-press the icon, then Capture) opens straight in.
  const asked = new URLSearchParams(location.search);
  // The Capture shortcut while Inkwell is already open: the open window is
  // sent to the shortcut's address (launch_handler in the manifest). Where a
  // phone only brings the window forward, its launch still comes through here.
  // The launch that opened this window was handled just above.
  let first = location.href;
  window.launchQueue?.setConsumer((params) => {
    const same = params.targetURL === first;
    first = null;
    if (!params.targetURL || same) return;
    const sp = new URL(params.targetURL).searchParams;
    if (sp.get('capture')) openCapture();
    if (/^\d{4}-\d{2}-\d{2}$/.test(sp.get('review') || '')) { reviewing = sp.get('review'); reviewAsked(); }
  });
  if (asked.has('capture') || asked.has('share') || asked.has('open') || asked.has('review') || asked.has('connect')) history.replaceState(history.state, '', location.pathname);
  if (/^\d{4}-\d{2}-\d{2}$/.test(asked.get('review') || '')) {
    reviewing = asked.get('review');
    // Signed in, wait for this device to catch up first (the review may
    // already have been made on another one); otherwise go now.
    const signedIn = !window.__claude && await sync.backend?.user?.().catch(() => null);
    if (signedIn) { await go({ view: 'notebook', pageId: dayId(reviewing) }); if (await getReview(reviewing)) await reviewAsked(); } else await reviewAsked();
  }
  if (asked.get('capture')) openCapture();
  if (asked.get('open')) { asking = asked.get('open'); await openAsked(); }
  // Shared from another app (or shared earlier and not yet placed).
  await landShares();
  sync.start();
  conflicts.count();
  // Scribe sent here to connect.
  if (asked.get('connect') === 'scribe') connectScribe().catch((e) => console.error(e));
  // Deleted things are remembered for six months, then this device lets go of them.
  forgetDeleted(Date.now() - 182 * 864e5).catch((e) => console.warn(e));
  keepStorage();
  // Old versions thin out: all from two days, hourly for two weeks, daily after.
  setTimeout(() => tidyHistory().catch((e) => console.warn(e)), 8000);
  // Search reads everything once; do it while idle so the first search is quick.
  setTimeout(() => (window.requestIdleCallback || setTimeout)(() => searchIndex().catch((e) => console.warn(e))), 15000);
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js');
}

start();
