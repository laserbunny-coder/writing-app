import { putEntries, getEntry, children, getMeta, setMeta, topTags, byKind, CLAUDE } from './db.js';
import { entry, tagsIn } from './model.js';
import { GAP } from './order.js';
import { addFile, localFile, uploadPending, isAudio } from './files.js';
import { setFileNote } from './filenode.js';
import { withTag } from './capture.js';
import { placeVoice } from './voice.js';
import { queueTask } from './daybook.js';

// Meetings: a recording of a meeting (Samsung's Voice Recorder shared into
// Inkwell, or a file added with Ctrl+K on the desk) lands on today's page,
// and once there's a connection it becomes a meeting page: a short summary,
// what was decided, the tasks with who's doing each, and the whole meeting
// written out with each speaker named. Your own tasks go on to Daybook, in
// Business or Filmmaking depending on what the meeting was about.
//
// A shared recording with only one voice in it is an idea said out loud, so
// it's written up like a Capture instead.

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d = new Date()) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
const blank = { done: false, gather: null, gathered: null, mirror: null };
const fileNode = (row) => ({ type: 'file', attrs: { id: row.id, name: row.title, type: row.fields.type, size: row.fields.size, duration: row.fields.duration || 0 } });
const textOf = (content) => (content || []).map((n) => (n.type === 'text' ? n.text : n.type === 'entryRef' ? n.attrs?.title || '' : '')).join('');
const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const minutes = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`; };
export const stamp = (t) => `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}`;

// ---------- waiting to be written out ----------

async function waiting() { return (await getMeta('meetingQueue')) || []; }
export async function queueMeeting(item) { await setMeta('meetingQueue', [...(await waiting()).filter((q) => q.line !== item.line), item]); }
async function update(lineId, change) { await setMeta('meetingQueue', (await waiting()).map((q) => (q.line === lineId ? { ...q, ...change } : q))); }
async function unqueue(lineId) { await setMeta('meetingQueue', (await waiting()).filter((q) => q.line !== lineId)); }
export const pendingMeetings = () => waiting();

// The first recording on a line, if it has one.
export const audioOn = (line) => (line?.content || []).find((n) => n.type === 'file' && isAudio(n.attrs?.type))?.attrs || null;

// A recording added from this device (Ctrl+K on the desk): it goes on
// today's page like a share does, and is queued as a meeting.
export async function addMeetingFile(file, day = isoOf(new Date())) {
  const row = await addFile(file);
  if (!row) return null;
  const dayId = `day-${day}`;
  const rows = [row];
  const dayRow = await getEntry(dayId);
  if (!dayRow || dayRow.deleted) rows.push({ ...(dayRow || entry('day', { id: dayId, title: day })), deleted: false, updated_at: Date.now() });
  const kids = await children(dayId);
  const sort = kids.length ? Math.max(...kids.map((k) => k.sort || 0)) + GAP : GAP;
  const content = [fileNode(row), { type: 'text', text: ` ${clock()} Meeting` }];
  const text = textOf(content);
  const line = entry('line', { parent_id: dayId, sort, text, content, tags: tagsIn(text), fields: { ...blank, capture: 'meeting' } });
  rows.push(line);
  await putEntries(rows.filter((r) => r !== row));
  await queueMeeting({ line: line.id, file: row.id, wrote: text, at: Date.now(), asked: true });
  return { line, rows };
}

// Makes a line that already has a recording on it into a meeting.
export async function meetingFromLine(lineId) {
  const line = await getEntry(lineId);
  const audio = audioOn(line);
  if (!audio) return null;
  await queueMeeting({ line: line.id, file: audio.id, wrote: line.text, at: Date.now(), asked: true });
  return line;
}

// ---------- the meeting page ----------

// More than one voice, each saying a fair share, makes it a meeting.
export function isMeeting(said) {
  const words = new Map();
  let total = 0;
  for (const x of said) { const n = x.text.split(/\s+/).length; words.set(x.s, (words.get(x.s) || 0) + n); total += n; }
  return [...words.values()].filter((n) => n >= Math.max(15, total * 0.08)).length >= 2;
}

export const pageIdOf = (it) => `pg_meet-${it.file}`;
export const speakerName = (names, s) => names?.[s] || `Speaker ${Number(s) + 1}`;

// One line said by one person: their name in bold, when, then the words.
export const saidContent = (name, x) => [{ type: 'text', text: name, marks: [{ type: 'bold' }] }, { type: 'text', text: ` ${stamp(x.t)}  ${x.text}` }];

function lineRow(id, parent, sort, content, extra = {}, prev = null) {
  const text = textOf(content);
  return { ...(prev || entry('line', { id })), kind: 'line', parent_id: parent, sort: prev?.sort ?? sort, text, content, tags: tagsIn(text), links: [], deleted: false, updated_at: Date.now(), fields: { ...(prev?.fields || {}), ...blank, ...(extra.fields || {}) }, ...(extra.by ? { _by: extra.by } : {}) };
}
const plain = (text) => [{ type: 'text', text }];

// A life project can take a kind of meeting ("Meeting notes go here" in its
// menu sets fields.meetings); the meeting page is filed under the first one
// that does. Otherwise it stays a loose page.
export async function homeFor(kind) {
  if (!kind) return null;
  return (await byKind('world')).find((x) => x.fields?.life && (x.fields.meetings || []).includes(kind)) || null;
}

// The page, with the recording at the top and the write-out under it. Notes
// (summary, decisions, tasks) go between them once Claude has written them.
export async function placeMeeting(it, { said = [], duration = 0, notes = null, names = {} }) {
  const pid = pageIdOf(it);
  const prevPage = await getEntry(pid);
  const day = (await getEntry(it.line))?.parent_id?.replace(/^day-/, '') || isoOf(new Date(it.at));
  const title = notes?.title || prevPage?.title || `Meeting ${day}`;
  const now = Date.now();
  const rows = [];
  // Filed once, when its kind is first known; after that it stays wherever you move it.
  const home = !prevPage?.parent_id && !prevPage?.fields?.meeting?.kind && notes ? await homeFor(notes.kind) : null;
  rows.push({ ...(prevPage || entry('page', { id: pid })), kind: 'page', title, parent_id: home ? home.id : (prevPage?.parent_id ?? null), ...(home ? { area_id: home.area_id || null } : {}), deleted: false, updated_at: now, fields: { ...(prevPage?.fields || {}), meeting: { file: it.file, line: it.line, day, duration, kind: notes?.kind || prevPage?.fields?.meeting?.kind || null, names } } });
  const kids = new Map((await children(pid)).map((k) => [k.id, k]));
  const file = await getEntry(it.file);
  const top = [];
  if (file) top.push(lineRow(`${pid}-rec`, pid, GAP, [fileNode(file), { type: 'text', text: ` ${shortDay(day)}${duration ? `, ${minutes(duration)}` : ''}` }], {}, kids.get(`${pid}-rec`)));
  if (notes) {
    const section = (key, heading, items, sort) => {
      if (!items.length) return;
      top.push(lineRow(`${pid}-${key}`, pid, sort, [{ type: 'text', text: heading, marks: [{ type: 'bold' }] }], { by: CLAUDE }, kids.get(`${pid}-${key}`)));
      items.forEach((it2, i) => top.push(lineRow(`${pid}-${key}${i + 1}`, `${pid}-${key}`, (i + 1) * GAP, it2.content, { by: CLAUDE, fields: it2.fields }, kids.get(`${pid}-${key}${i + 1}`))));
    };
    section('sum', 'Summary', notes.summary.map((s) => ({ content: plain(s) })), 2 * GAP);
    section('dec', 'Decided', notes.decisions.map((s) => ({ content: plain(s) })), 3 * GAP);
    section('do', 'To do', notes.tasks.map((t) => ({ content: plain(`${t.title}${t.owner ? ` · ${t.owner}` : ''}${t.due ? ` · by ${shortDay(t.due)}` : ''}`), fields: { owner: t.owner || '', due: t.due || '', task_notes: t.notes || '' } })), 4 * GAP);
  }
  const said0 = `${pid}-said`;
  top.push(lineRow(said0, pid, 5 * GAP, [{ type: 'text', text: 'Write-out', marks: [{ type: 'bold' }] }], {}, kids.get(said0)));
  // The write-out's own lines are kept by their place, so a retry overwrites rather than doubles.
  const old = new Map((await children(said0)).map((k) => [k.id, k]));
  said.forEach((x, i) => top.push(lineRow(`${said0}${i + 1}`, said0, (i + 1) * GAP, saidContent(speakerName(names, x.s), x), { fields: { speaker: x.s, at: x.t } }, old.get(`${said0}${i + 1}`))));
  rows.push(...top);
  await putEntries(rows);
  return rows;
}

// The line on today's page points to the meeting page once it has a name.
async function linkDayLine(it, title) {
  const line = await getEntry(it.line);
  if (!line || line.deleted) return [];
  const pid = pageIdOf(it);
  const ref = { type: 'entryRef', attrs: { id: pid, title } };
  let row;
  if (line.text === it.wrote) {
    const was = line.content || [];
    const upTo = was.findLastIndex((n) => n.type !== 'text');
    const content = [...was.slice(0, upTo + 1), { type: 'text', text: ' ' }, ref];
    const text = textOf(content);
    row = { ...line, content, text, tags: tagsIn(text), links: [...new Set([...(line.links || []), pid])], fields: { ...line.fields, meeting: pid }, updated_at: Date.now() };
  } else {
    // You've written on the line, so the link goes just under it.
    const kids = await children(line.id);
    const id = `${line.id}-m`;
    const sort = kids.length ? Math.max(...kids.map((k) => k.sort || 0)) + GAP : GAP;
    row = { ...lineRow(id, line.id, sort, [ref], { by: CLAUDE }, kids.find((k) => k.id === id)), links: [pid] };
  }
  await putEntries([row]);
  return [row];
}

// Tasks that are yours (or nobody's) go to Daybook in the meeting's area;
// tasks someone else took stay on the page with their name.
export const mine = (owner, me) => !owner || (!!me && owner.toLowerCase().split(/\s+/)[0] === me.toLowerCase().split(/\s+/)[0]);

async function sendTasks(it, notes, { me, areas, base }) {
  const pid = pageIdOf(it);
  let areaId = null;
  try {
    const list = (await areas?.()) || [];
    const want = notes.kind === 'business' ? /business/i : notes.kind === 'filmmaking' ? /film/i : null;
    areaId = want ? list.find((a) => want.test(a.title))?.id || null : null;
  } catch (e) { console.warn(e); }
  const rows = [];
  for (const [i, t] of notes.tasks.entries()) {
    if (!mine(t.owner, me)) continue;
    const lineId = `${pid}-do${i + 1}`;
    const id = `inkwell-${lineId}`;
    const extra = [t.notes, t.due ? `By ${shortDay(t.due)}.` : '', `From ${notes.title}.`].filter(Boolean).join(' ');
    await queueTask({ id, title: t.title, notes: extra, link: `${base}?open=${encodeURIComponent(lineId)}`, area_id: areaId, deleted: false });
    const line = await getEntry(lineId);
    if (line) rows.push({ ...line, fields: { ...line.fields, daybook: { id, at: Date.now() } }, updated_at: Date.now() });
  }
  if (rows.length) await putEntries(rows);
  return rows;
}

// Names from earlier meetings help Claude tell who's who.
async function knownPeople() { return (await getMeta('meetingPeople')) || []; }
async function learnPeople(names) {
  const add = Object.values(names).filter((n) => n && !/^Speaker \d+$/.test(n));
  if (add.length) await setMeta('meetingPeople', [...new Set([...add, ...(await knownPeople())])].slice(0, 30));
}

let busy = null;
let retry = null;

// Works through what's waiting: the recording goes up and comes back
// written out (kept on the page at once), then Claude's notes go on, then
// your tasks go to Daybook. `ask` sends a request to the server.
export function meetingPending({ ask, canAsk, onRows, me = () => '', areas, base, sendPending, onDone }) {
  busy ||= (async () => {
    clearTimeout(retry);
    const items = await waiting();
    for (const it of items) setFileNote(it.file, it.said ? 'writing the notes…' : 'waiting to be written out');
    if (!items.length || !canAsk()) return;
    await uploadPending();
    for (const it of items) {
      const kept = await localFile(it.file);
      if (kept && !kept.uploaded) continue; // still going up; next time
      let { said, duration } = it;
      if (!said) {
        setFileNote(it.file, 'writing out the meeting…');
        try {
          ({ said = [], duration = 0 } = (await ask({ mode: 'meeting-writeout', file: it.file })) || {});
        } catch (e) {
          setFileNote(it.file, e.code === 'no-meeting-transcriber' ? 'waiting for meeting write-outs to be set up' : 'waiting to be written out');
          if (e.code === 'no-meeting-transcriber') break;
          if (e.status && e.status < 500 && e.status !== 429 && e.status !== 404) { await unqueue(it.line); setFileNote(it.file, ''); }
          continue;
        }
        if (!said.length) { await unqueue(it.line); setFileNote(it.file, 'nothing was said in this recording'); continue; }
        // A shared recording with one voice is an idea, written out like a Capture.
        if (!it.asked && !isMeeting(said)) {
          const transcript = said.map((x) => x.text).join(' ');
          let answer = { raw: transcript };
          try { answer = { raw: transcript, ...(await ask({ mode: 'voice', transcript, duration, place: 'day', tags: await topTags(40) })) }; } catch (e) { console.warn(e); }
          const rows = await placeVoice({ line: it.line, wrote: it.wrote }, answer, { withTag });
          await unqueue(it.line);
          setFileNote(it.file, '');
          if (rows.length) onRows(rows);
          continue;
        }
        await update(it.line, { said, duration });
        onRows([...await placeMeeting(it, { said, duration }), ...await linkDayLine(it, `Meeting ${isoOf(new Date(it.at))}`)]);
      }
      setFileNote(it.file, 'writing the notes…');
      let notes;
      try {
        notes = await ask({ mode: 'meeting-notes', said, me: me(), people: await knownPeople(), date: isoOf(new Date(it.at)) });
      } catch (e) {
        console.warn('meeting notes failed, will retry', e);
        setFileNote(it.file, 'notes still to come');
        continue;
      }
      const names = {};
      for (const s of notes.speakers || []) names[s.id] = s.name;
      notes = { title: notes.title || 'Meeting', kind: notes.kind || 'other', summary: notes.summary || [], decisions: notes.decisions || [], tasks: notes.tasks || [] };
      const rows = [...await placeMeeting(it, { said, duration, notes, names }), ...await linkDayLine(it, notes.title)];
      rows.push(...await sendTasks(it, notes, { me: me(), areas, base: base() }));
      await learnPeople(names);
      await unqueue(it.line);
      setFileNote(it.file, '');
      onRows(rows);
      sendPending?.();
      onDone?.(it, notes);
    }
  })().catch((e) => console.error(e)).finally(() => {
    busy = null;
    waiting().then((left) => { if (left.length) retry = setTimeout(() => meetingPending({ ask, canAsk, onRows, me, areas, base, sendPending, onDone }), 3 * 60 * 1000); });
  });
  return busy;
}

// ---------- fixing a speaker's name ----------

// Every line the speaker said gets the new name, here and in later meetings.
export async function renameSpeaker(pageId, from, to) {
  const page = await getEntry(pageId);
  const m = page?.fields?.meeting;
  if (!m || !to.trim()) return [];
  const said0 = `${pageId}-said`;
  const lines = await children(said0);
  const ids = new Set(lines.filter((l) => speakerName(m.names, l.fields?.speaker) === from).map((l) => l.fields.speaker));
  if (!ids.size) return [];
  const names = { ...m.names };
  for (const s of ids) names[s] = to.trim();
  const rows = [{ ...page, fields: { ...page.fields, meeting: { ...m, names } }, updated_at: Date.now() }];
  for (const l of lines) {
    if (!ids.has(l.fields?.speaker)) continue;
    const content = [{ type: 'text', text: to.trim(), marks: [{ type: 'bold' }] }, ...(l.content || []).slice(1)];
    const text = textOf(content);
    rows.push({ ...l, content, text, tags: tagsIn(text), updated_at: Date.now() });
  }
  await putEntries(rows);
  await learnPeople({ x: to.trim() });
  return rows;
}

// The names on a meeting page, for the rename menu.
export async function speakersOn(pageId) {
  const page = await getEntry(pageId);
  const m = page?.fields?.meeting;
  if (!m) return [];
  const lines = await children(`${pageId}-said`);
  return [...new Set(lines.map((l) => speakerName(m.names, l.fields?.speaker)))];
}
