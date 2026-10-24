// Meetings: a recording shared into Inkwell (or added with Ctrl + K) is
// written out with each speaker told apart, and becomes a meeting page with a
// summary, what was decided, the tasks and the write-out; your own tasks go
// to Daybook in the meeting's area. A shared recording with one voice is an
// idea, written up like a Capture. window.__claude stands in for the server,
// window.__daybook for Daybook's table and window.__areas for its areas.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 4192;
const server = spawn('node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await sleep(1500);
const URL = `http://localhost:${PORT}/`;

const sent = [];
const asked = [];
const MEETING = [
  { s: 0, t: 0, text: 'Okay Nate, let’s sort out summer camp. I think we run it the last two weeks of July.' },
  { s: 1, t: 9, text: 'Agreed, Michael. I’ll call the gym about renting the big room, and you send the flyer to the parents.' },
  { s: 0, t: 21, text: 'Deal. I’ll get the flyer out by Friday. We still need to decide on the price for siblings.' },
  { s: 1, t: 30, text: 'Let’s think about the sibling price and talk next week.' }
];
const IDEA = [{ s: 0, t: 0, text: 'An idea for the Ninja Bunch: the smallest ninja is the only one who can actually hide, and nobody believes she exists.' }];
function claude(body) {
  asked.push(body.mode);
  if (body.mode === 'meeting-writeout') return body.file === 'IDEA' ? { said: IDEA, duration: 12 } : { said: MEETING, duration: 2410 };
  if (body.mode === 'meeting-notes') {
    return {
      title: 'Summer camp with Nate', kind: 'business',
      speakers: [{ id: 0, name: 'Michael' }, { id: 1, name: 'Nate' }],
      summary: ['Michael and Nate planned summer camp for the last two weeks of July.'],
      decisions: ['Camp runs the last two weeks of July.'],
      tasks: [{ title: 'Send the camp flyer to parents', owner: 'Michael', notes: '', due: '2026-10-30' }, { title: 'Call the gym about the big room', owner: 'Nate', notes: '', due: '' }, { title: 'Decide the sibling price', owner: '', notes: 'Talk next week.', due: '' }]
    };
  }
  if (body.mode === 'voice') return { raw: body.transcript, mode: 'idea', blocks: [{ text: 'Premise: the smallest ninja is the only one who can hide', el: 'paragraph', new_scene: false }], notes: [], tag: 'ninja-bunch', refs: [] };
  throw new Error(`unexpected ${body.mode}`);
}

const fake = () => {
  window.__syncBackend = {
    user: async () => ({ id: 'u1', user_metadata: { full_name: 'Michael Tester' } }), onAuth() {}, signIn() {}, signOut() {},
    push: async (rows) => rows.map((r) => ({ id: r.id, updated_at: new Date().toISOString() })),
    pull: async () => [], async upload() {}, async download() { throw new Error('not found'); },
    subscribe() {}, unsubscribe() {}
  };
  window.__claude = async (body) => {
    // The idea recording is told apart by its name, as the server would by its words.
    if (body.mode === 'meeting-writeout') {
      const r = await new Promise((res) => { const q = indexedDB.open('writing'); q.onsuccess = () => { const g = q.result.transaction('entries').objectStore('entries').get(body.file); g.onsuccess = () => res(g.result); }; });
      if (/idea/i.test(r?.title || '')) body = { ...body, file: 'IDEA' };
    }
    return window.__server(body);
  };
  window.__daybook = (task) => window.__toDaybook(task);
  window.__areas = async () => [{ id: 'area-biz', title: 'Business' }, { id: 'area-film', title: 'Filmmaking' }];
};

const entries = (p, kind) => p.evaluate((kind) => new Promise((res) => {
  const r = indexedDB.open('writing');
  r.onsuccess = () => { const q = r.result.transaction('entries').objectStore('entries').index('kind').getAll(kind); q.onsuccess = () => res(q.result.filter((l) => !l.deleted)); };
}), kind);
const command = async (p, name) => {
  await p.keyboard.press('Control+K');
  await p.keyboard.type(name);
  await sleep(250);
  await p.keyboard.press('Enter');
  await sleep(500);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.exposeFunction('__server', claude);
await ctx.exposeFunction('__toDaybook', (t) => { sent.push(t); return true; });
await ctx.addInitScript(fake);
const page = await ctx.newPage();
page.errors = [];
page.on('pageerror', (e) => page.errors.push(e.message));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// What Android does when Voice Recorder shares a recording.
async function shareRecording(name) {
  await page.evaluate(async (name) => {
    const form = new FormData();
    form.append('title', '');
    form.append('text', '');
    form.append('url', '');
    form.append('files', new File([new Uint8Array(2000)], name, { type: 'audio/mp4' }));
    const res = await fetch('./share', { method: 'POST', body: form });
    window.__landed = res.url;
  }, name);
  await page.goto(`${URL}?share=1`);
  await page.waitForSelector('#outline-editor .ProseMirror');
}

try {
  await page.goto(URL);
  await page.waitForSelector('#editor .ProseMirror');
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }); });

  // A life project that takes business meetings ("Meeting notes go here").
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('writing');
    r.onsuccess = () => {
      const tx = r.result.transaction('entries', 'readwrite');
      const base = { parent_id: null, sort: 0, text: '', content: null, tags: [], type: null, links: [], deleted: false, created_at: 1, updated_at: 1 };
      tx.objectStore('entries').put({ ...base, id: 'wd_film', kind: 'world', title: 'Ninja Bunch', area_id: 'area-filmmaking', fields: { life: true, meetings: ['filmmaking'] } });
      tx.objectStore('entries').put({ ...base, id: 'wd_acro', kind: 'world', title: 'Acro Dance', area_id: 'area-business', fields: { life: true, meetings: ['business'] } });
      tx.oncomplete = res;
    };
  }));

  let meeting;
  await check('a shared meeting recording becomes a meeting page, linked from today’s line', async () => {
    await shareRecording('Camp meeting.m4a');
    await page.waitForFunction(() => /Summer camp with Nate/.test(document.querySelector('#outline-editor .ProseMirror')?.innerText || ''), null, { timeout: 10000 });
    meeting = (await entries(page, 'page')).find((p) => p.fields?.meeting);
    assert.equal(meeting.title, 'Summer camp with Nate');
    assert.equal(meeting.fields.meeting.kind, 'business');
    assert.equal(meeting.parent_id, 'wd_acro', 'filed in the life project that takes business meetings');
    assert.equal(meeting.area_id, 'area-business');
    const lines = await entries(page, 'line');
    const day = lines.find((l) => l.fields?.meeting === meeting.id);
    assert.ok(day, 'today’s line points to it');
    assert.ok(day.content.some((n) => n.type === 'entryRef' && n.attrs.id === meeting.id));
    assert.deepEqual(asked.slice(0, 2), ['meeting-writeout', 'meeting-notes']);
  });

  await check('the page has the summary, what was decided, the tasks with owners, and who said what', async () => {
    const lines = await entries(page, 'line');
    const kids = (id) => lines.filter((l) => l.parent_id === id).sort((a, b) => a.sort - b.sort);
    const top = kids(meeting.id).map((l) => l.text);
    assert.equal(kids(meeting.id)[0].content[0].type, 'file', 'the recording first');
    assert.match(kids(meeting.id)[0].text, /, 40 min$/);
    assert.deepEqual(top.slice(1), ['Summary', 'Decided', 'To do', 'Write-out']);
    assert.match(kids(`${meeting.id}-sum`)[0].text, /last two weeks of July/);
    assert.equal(kids(`${meeting.id}-dec`).length, 1);
    assert.deepEqual(kids(`${meeting.id}-do`).map((l) => l.text), ['Send the camp flyer to parents · Michael · by Oct 30', 'Call the gym about the big room · Nate', 'Decide the sibling price']);
    const said = kids(`${meeting.id}-said`);
    assert.equal(said.length, 4);
    assert.match(said[1].text, /^Nate 0:09 {2}Agreed/);
    assert.equal(said[1].content[0].marks[0].type, 'bold');
  });

  await check('your tasks and nobody’s go to Daybook in Business; Nate’s stay on the page', async () => {
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && sent.length < 2; i++) await sleep(150);
    assert.deepEqual(sent.map((t) => t.title).sort(), ['Decide the sibling price', 'Send the camp flyer to parents']);
    assert.ok(sent.every((t) => t.area_id === 'area-biz'));
    assert.match(sent.find((t) => /flyer/.test(t.title)).notes, /By Oct 30\. From Summer camp with Nate\./);
    assert.match(sent[0].link, /\?open=pg_meet-/);
  });

  await check('a speaker’s name can be fixed on every line they said', async () => {
    await page.goto(`${URL}?open=${meeting.id}`);
    await page.waitForFunction(() => /Write-out/.test(document.querySelector('#outline-editor .ProseMirror')?.innerText || ''), null, { timeout: 8000 });
    await command(page, 'Fix a speaker');
    await page.locator('.pop-menu button', { hasText: 'Nate' }).first().click();
    await sleep(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Nathan');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Nathan 0:09/.test(document.querySelector('#outline-editor .ProseMirror')?.innerText || ''), null, { timeout: 5000 });
    const lines = await entries(page, 'line');
    assert.equal(lines.filter((l) => /^Nathan /.test(l.text)).length, 2);
    const p = (await entries(page, 'page')).find((x) => x.id === meeting.id);
    assert.equal(p.fields.meeting.names[1], 'Nathan');
  });

  await check('a shared recording with one voice is written up like a Capture, not a meeting', async () => {
    const before = (await entries(page, 'page')).length;
    await shareRecording('Ninja idea.m4a');
    await page.waitForFunction(() => /smallest ninja is the only one who can hide/.test(document.querySelector('#outline-editor .ProseMirror')?.innerText || ''), null, { timeout: 10000 });
    assert.equal((await entries(page, 'page')).length, before, 'no meeting page');
    const line = (await entries(page, 'line')).find((l) => l.fields?.voice);
    assert.match(line.text, /#idea/);
    assert.equal(line.fields.voice.raw, IDEA[0].text, 'the words kept word for word');
    assert.match(line.text, /Premise: the smallest ninja/, 'Claude’s write-up on the line');
    assert.equal(line.fields.voice.mode, 'idea');
  });

  await check('nothing is left waiting', async () => {
    const q = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('writing'); r.onsuccess = () => { const g = r.result.transaction('meta').objectStore('meta').get('meetingQueue'); g.onsuccess = () => res(g.result?.value || []); }; }));
    assert.equal(q.length, 0);
  });

  await check('no page errors', async () => { assert.deepEqual(page.errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('meeting: all passed');
