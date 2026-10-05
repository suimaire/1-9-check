// 공개 학번 제출 학급 준비(운영자 PC 전용, 서버 키 사용 — 커밋 금지 파일 .env.server).
//  1) 학급 하나를 공개 제출 대상(public_submit)으로 지정하고 앱 이름을 '1-9 체크'로 맞춘다.
//  2) 학번 10901~10934를 명단에 등록한다(표시명 '학생 01'~'학생 34'). 이미 있는 학번의 표시명은 바꾸지 않는다.
//  3) --deactivate-others: 범위 밖 학번(예: 예전 TEST 학생)을 비활성화하고 대상 기간에서 뺀다(기록·계정은 지우지 않음).
// 사용: node --env-file=.env.server scripts/setup-public-class.mjs [--class-name "1학년 9반"] [--deactivate-others]
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './live-test-lib.mjs';

requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
const { values } = parseArgs({
  options: {
    'class-name': { type: 'string', default: '1학년 9반' },
    'deactivate-others': { type: 'boolean', default: false },
  },
});
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const must = (label, res) => {
  if (res.error) {
    console.error(`${label} 실패: ${res.error.message}`);
    process.exit(1);
  }
  return res.data;
};

const NOS = Array.from({ length: 34 }, (_, i) => `109${String(i + 1).padStart(2, '0')}`);

// 대상 학급: 이미 지정된 학급, 없으면 학급이 하나뿐일 때 그 학급
const classes = must('학급 조회', await admin.from('classes').select('id, name, public_submit'));
let klass = classes.find((c) => c.public_submit);
if (!klass) {
  if (classes.length !== 1) {
    console.error(`공개 제출 학급을 고를 수 없습니다(학급 ${classes.length}개). 하나만 지정해 주세요.`);
    process.exit(1);
  }
  klass = classes[0];
}
must('학급 지정', await admin.from('classes')
  .update({ name: values['class-name'], app_title: '1-9 체크', app_subtitle: '시험기간 스크린타임 인증', public_submit: true })
  .eq('id', klass.id));
console.log(`공개 제출 학급: ${values['class-name']} (이전 이름 ${klass.name})`);

const students = must('명단 조회', await admin.from('students').select('id, student_no, name, active, roster_until').eq('class_id', klass.id));
const have = new Set(students.map((s) => s.student_no));
const add = NOS.filter((n) => !have.has(n)).map((n) => ({ class_id: klass.id, student_no: n, name: `학생 ${n.slice(3)}` }));
if (add.length) must('학번 등록', await admin.from('students').insert(add));
console.log(`학번 등록: 신규 ${add.length}명, 기존 ${NOS.length - add.length}명`);

if (values['deactivate-others']) {
  const terms = must('운영 기간 조회', await admin.from('terms').select('start_date').eq('class_id', klass.id).order('start_date').limit(1));
  const first = terms[0]?.start_date;
  const until = first ? new Date(Date.parse(`${first}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
  const others = students.filter((s) => !NOS.includes(s.student_no) && s.active);
  for (const s of others) {
    must(`비활성화 ${s.student_no}`, await admin.from('students')
      .update({ active: false, roster_until: until, updated_at: new Date().toISOString() }).eq('id', s.id));
  }
  console.log(`범위 밖 학번 비활성화: ${others.map((s) => s.student_no).join(', ') || '없음'}`);
}
