import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptKey, decryptKey } from '../src/worker/crypto';
import { derivePassword, encode, equalHash, validateCredentials } from '../src/worker/password';
import { ensureDatabase, isMissingPanelTable } from '../src/worker/schema';

test('password hashes use random salt and separate wrapping keys, and reject invalid setup credentials', async () => {
  const salt=encode(crypto.getRandomValues(new Uint8Array(32)));
  const first=await derivePassword('correct-password-long',salt);
  const repeated=await derivePassword('correct-password-long',salt);
  const wrong=await derivePassword('wrong-password-long',salt);
  const another=await derivePassword('correct-password-long',encode(crypto.getRandomValues(new Uint8Array(32))));
  assert.equal(equalHash(first.hash,repeated.hash),true);assert.equal(equalHash(first.hash,wrong.hash),false);
  assert.notEqual(first.hash,first.wrappingKey);assert.notEqual(first.hash,another.hash);
  assert.deepEqual(validateCredentials({username:' Owner ',password:'correct-password-long'},true),{username:'owner',password:'correct-password-long'});
  assert.throws(()=>validateCredentials({username:'admin',password:'short'},true));
  assert.throws(()=>validateCredentials({username:'bad username',password:'correct-password-long'},true));
});
test('only missing panel tables trigger initialization; other database errors stay errors',async()=>{
  assert.equal(isMissingPanelTable(new Error('D1_ERROR: no such table: insb_admin')),true);
  assert.equal(isMissingPanelTable(new Error('outer',{cause:new Error('no such table: main.insb_sessions')})),true);
  assert.equal(isMissingPanelTable(new Error('no such table: other_app_users')),false);
  assert.equal(isMissingPanelTable(new Error('database is locked')),false);
  let batches=0;const failure=new Error('D1_ERROR: database disk image is malformed');
  const db={prepare:()=>({first:async()=>{throw failure;}}),batch:async()=>{batches++;}} as unknown as D1Database;
  await assert.rejects(()=>ensureDatabase(db),error=>error===failure);assert.equal(batches,0);
});
test('encrypted credentials are randomized, authenticated, and bound to an account',async()=>{
  const secret=Buffer.alloc(32,7).toString('base64');
  const a=await encryptKey('ibk_test_secret',secret,'account-a');
  const b=await encryptKey('ibk_test_secret',secret,'account-a');
  assert.notEqual(a.ciphertext,b.ciphertext);
  assert.equal(await decryptKey(a.ciphertext,a.iv,secret,'account-a'),'ibk_test_secret');
  await assert.rejects(()=>decryptKey(a.ciphertext,a.iv,secret,'account-b'));
  await assert.rejects(()=>decryptKey(a.ciphertext,a.iv,Buffer.alloc(32,8).toString('base64'),'account-a'));
  await assert.rejects(()=>encryptKey('ibk_test','invalid','a'));
});
