import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const context = { exports: {}, URL, require: () => ({}) };
vm.runInNewContext(ts.transpile(fs.readFileSync('src/features/video/SharedYoutube.tsx', 'utf8'), { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }), context);
const { youtubeVideoId, validYoutubeSession } = context.exports;
test('YouTube links accept watch, share, shorts and live URLs without arbitrary embeds', () => {
  const id = 'abcdefghI_1';
  for (const link of [`https://youtu.be/${id}?si=test`, `https://www.youtube.com/watch?v=${id}`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`, `https://www.youtube-nocookie.com/embed/${id}`]) assert.equal(youtubeVideoId(link), id);
  for (const link of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=abcdefghI_1', 'https://evil.test/embed/abcdefghI_1', 'https://youtube.com/watch?v=bad', '<iframe src=x>']) assert.equal(youtubeVideoId(link), null);
});
test('shared playback snapshots validate times and identifiers before use', () => {
  const state = { videoId: 'abcdefghI_1', time: 10, playing: true, updatedAt: Date.now() };
  assert.equal(validYoutubeSession(state), true);
  for (const next of [null, { ...state, time: -1 }, { ...state, time: Infinity }, { ...state, playing: 'true' }, { ...state, videoId: '<script>' }, { ...state, updatedAt: NaN }]) assert.equal(validYoutubeSession(next), false);
});
