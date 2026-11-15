// Run the actual Edge handler locally; only Supabase transport and Deno.serve are stubbed.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const temp = mkdtempSync(join(tmpdir(), '1-9-submit-test-'));
const root = new URL('../supabase/functions/submit/', import.meta.url);
let handler;
globalThis.Deno = { serve: callback => { handler = callback; } };
const calls = [], objects = new Set();
let commitError = null, replay = false;
const term = randomUUID(), student = randomUUID();
const result = { record_date: '2026-11-21', version: 1, image_count: 1, token_issued: true, replayed: true };
globalThis.testAdmin = {
  rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'login_rate_check') return { data: true, error: null };
    if (name === 'public_info') return { data: { ready: true }, error: null };
    if (name === 'public_recover_submission') return { data: replay ? result : null, error: null };
    if (args.p_images === null) return { data: { ready: true, student_id: student, term_id: term }, error: null };
    return { data: commitError ? null : { ...result, replayed: false }, error: commitError };
  },
  storage: { from: () => ({
    upload: async path => { objects.add(path); return { error: null }; },
    remove: async paths => { paths.forEach(path => objects.delete(path)); return { error: null }; },
  }) },
};
try {
  writeFileSync(join(temp,'util.ts'), `
    export const adminClient = () => globalThis.testAdmin;
    export const BUCKET = 'screenshots';
    export const clientIp = () => '127.0.0.1';
    export const corsHeaders = () => ({});
    export const dbErrorCode = e => e.code === 'P0001' ? e.message : 'server_error';
    export const json = (_req, body, status=200) => Response.json(body,{status});
    export const fail = (req, error, status=400) => json(req,{error},status);
    export const readJson = req => req.json();
    export const randomHex = n => 'a'.repeat(n*2);
  `);
  const source = readFileSync(new URL('index.ts',root),'utf8')
    .replace('../_shared/util.ts','./util.ts')
    .replace('./files.ts',new URL('files.ts',root).href)
    .replace('./cleanup.ts',new URL('cleanup.ts',root).href);
  writeFileSync(join(temp,'index.ts'),source);
  await import(pathToFileURL(join(temp,'index.ts')).href);
  const jsonRequest = body => new Request('http://local/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handler(jsonRequest({action:'info'}))).status,200);
  const recovery = {action:'recover',student_no:'10901',term_id:term,record_date:'2026-11-21',request_id:randomUUID()};
  assert.equal((await handler(jsonRequest({...recovery,request_id:'guess'}))).status,400);
  assert.equal(await (await handler(jsonRequest(recovery))).json(),null);
  replay=true;
  const receipt=await (await handler(jsonRequest(recovery))).json();
  assert.equal(receipt.replacement_token.length,64);
  assert.ok(!('token_issued' in receipt));
  const request = (withTerm=true) => {
    const form=new FormData();
    for (const [key,value] of Object.entries({student_no:'10901',record_date:'2026-11-21',request_id:randomUUID(),...(withTerm?{term_id:term}:{})})) form.append(key,value);
    form.append('files',new File([new Uint8Array([137,80,78,71,13,10,26,10,1])],'test.png',{type:'image/png'}));
    return new Request('http://local/submit',{method:'POST',body:form});
  };
  assert.equal((await handler(request())).status,200);
  const stages=calls.filter(c=>c.name==='public_submit_images_for_term');
  assert.equal(stages.length,2);
  assert.ok(stages.every(c=>c.args.p_expected_term_id===term));
  assert.equal(objects.size,1);
  commitError={code:'',message:'Failed to fetch'};
  assert.equal((await handler(request())).status,500);
  assert.equal(objects.size,2,'unknown commit result preserves uploaded images');
  commitError={code:'P0001',message:'not_participant'};
  assert.equal((await handler(request())).status,409);
  assert.equal(objects.size,2,'explicit rejection removes only the new upload');
  commitError=null;
  assert.equal((await handler(request(false))).status,200);
  assert.ok(calls.some(c=>c.name==='public_submit_images'));
  console.log('PASS: real Edge handler recovery, term binding in both RPC stages, legacy requests, safe cleanup');
} finally {
  for(const name of ['index.ts','util.ts']) unlinkSync(join(temp,name));
  rmdirSync(temp);
  delete globalThis.testAdmin;
  delete globalThis.Deno;
}
