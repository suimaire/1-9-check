// 최초 교사 계정 + 학급 생성(운영자가 로컬에서 한 번 실행).
// 서버 비밀 키는 이 터미널에서만 사용하고 저장소·프런트엔드에 두지 않는다.
//
// 사용(PowerShell):
//   node --env-file=.env.server scripts/bootstrap-teacher.mjs --login-id t10900 --name "담임" --class "1학년 9반"
// .env.server에는 SUPABASE_URL, SUPABASE_SECRET_KEY, ALIAS_EMAIL_DOMAIN만 둔다(.gitignore 대상).
import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const { values } = parseArgs({
  options: {
    'login-id': { type: 'string' },
    name: { type: 'string' },
    class: { type: 'string' },
    title: { type: 'string', default: '1-9 체크' },
    subtitle: { type: 'string', default: '시험기간 우리 반 루틴' },
  },
});

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.ALIAS_EMAIL_DOMAIN;
const loginId = values['login-id']?.trim().toLowerCase();

if (!url || !secret || !domain) {
  console.error('SUPABASE_URL, SUPABASE_SECRET_KEY, ALIAS_EMAIL_DOMAIN 환경 변수가 필요합니다.');
  process.exit(1);
}
if (!loginId || !/^[0-9a-z-]{1,32}$/.test(loginId) || !values.name || !values.class) {
  console.error('사용법: --login-id <영문소문자·숫자·-> --name <표시 이름> --class <학급 이름>');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 14 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const email = `u-${randomBytes(10).toString('hex')}@${domain}`;

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: taken } = await admin.from('login_aliases').select('login_id').eq('login_id', loginId).maybeSingle();
if (taken) {
  console.error(`로그인 ID '${loginId}'가 이미 있습니다.`);
  process.exit(1);
}

const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error) {
  console.error('Auth 사용자 생성 실패:', created.error.message);
  process.exit(1);
}
const uid = created.data.user.id;

async function step(label, promise) {
  const { data, error } = await promise;
  if (error) {
    console.error(`${label} 실패: ${error.message} — 생성한 Auth 사용자를 되돌립니다.`);
    await admin.auth.admin.deleteUser(uid);
    process.exit(1);
  }
  return data;
}

await step('프로필', admin.from('profiles').insert({ user_id: uid, role: 'teacher', display_name: values.name, must_change_password: true }));
await step('로그인 별칭', admin.from('login_aliases').insert({ login_id: loginId, user_id: uid, auth_email: email }));
const klass = await step('학급', admin.from('classes').insert({ name: values.class, app_title: values.title, app_subtitle: values.subtitle }).select('id').single());
await step('담당 연결', admin.from('class_teachers').insert({ class_id: klass.id, teacher_id: uid }));

console.log('\n교사 계정을 만들었습니다. 아래 임시 비밀번호는 지금 한 번만 표시됩니다.');
console.log(`  로그인 ID : ${loginId}`);
console.log(`  임시 비밀번호 : ${password}`);
console.log(`  학급 : ${values.class}`);
console.log('첫 로그인 때 비밀번호를 바꿔야 학급 자료에 접근할 수 있습니다.\n');
