// 실연결 검증(합성 TEST 계정 전용) 공용 도구.
// 비밀번호·키는 콘솔에 출력하지 않고 verification.local/live-supabase-e2e/TEST_CREDENTIALS.txt에만 쓴다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = join(ROOT, 'verification.local', 'live-supabase-e2e');
export const CRED_FILE = join(OUT_DIR, 'TEST_CREDENTIALS.txt');

export const TEACHER = { loginId: 'TST-TEACHER', name: '테스트 담임' };
export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`.env.server에 다음 값이 필요합니다: ${missing.join(', ')}`);
    process.exit(1);
  }
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (key && /^sb_secret_/.test(key)) {
    console.error('SUPABASE_PUBLISHABLE_KEY에 secret key가 들어 있습니다.');
    process.exit(1);
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 영문+숫자를 반드시 포함하는 무작위 비밀번호(앱의 비밀번호 규칙 충족) */
export function strongPassword(length = 20) {
  for (;;) {
    const pw = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

export function readCredentials() {
  if (!existsSync(CRED_FILE)) return new Map();
  const map = new Map();
  for (const line of readFileSync(CRED_FILE, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [loginId, password, note = ''] = line.split('\t');
    if (loginId && password) map.set(loginId, { password, note });
  }
  return map;
}

export function writeCredentials(map) {
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [
    '# 1-9 체크 실연결 검증용 합성 TEST 계정 — 실제 학생 계정 아님',
    '# 로컬 전용 파일. 업로드·공유·커밋 금지. 앱 로그인 화면에는 login_id만 입력한다(내부 이메일 별칭 없음).',
    '# 형식: login_id<TAB>현재 비밀번호<TAB>상태',
  ];
  for (const [loginId, { password, note }] of map) lines.push(`${loginId}\t${password}\t${note}`);
  writeFileSync(CRED_FILE, lines.join('\n') + '\n', 'utf8');
}

export function setCredential(loginId, password, note) {
  const map = readCredentials();
  map.set(loginId, { password, note });
  writeCredentials(map);
}
