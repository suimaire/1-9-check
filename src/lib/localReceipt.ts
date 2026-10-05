// 이 기기에만 남기는 제출 기록. 서버에는 학번별 제출 여부를 묻는 공개 API가 없으므로
// '이미 냈는지'는 같은 기기에서만 편의상 보여 준다. 저장소를 쓸 수 없으면(사생활 보호 모드 등) 조용히 건너뛴다.
const PREFIX = '1-9-check';

export const STUDENT_NOS: ReadonlySet<string> = new Set(
  Array.from({ length: 34 }, (_, i) => `109${String(i + 1).padStart(2, '0')}`),
);

export interface Receipt {
  firstSubmittedAt: string;
  late: boolean;
  version: number;
}

const tokenKey = (no: string, date: string) => `${PREFIX}:replacement-token:${no}:${date}`;
const receiptKey = (no: string, date: string) => `${PREFIX}:receipt:${no}:${date}`;
const LAST_NO = `${PREFIX}:last-student-no`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장하지 못하면 이 기기에서 교체할 때 담임에게 재제출 허용을 요청하면 된다
  }
}

export function getToken(no: string, date: string): string | null {
  return read(tokenKey(no, date));
}

export function saveToken(no: string, date: string, token: string) {
  write(tokenKey(no, date), token);
}

export function getReceipt(no: string, date: string): Receipt | null {
  const raw = read(receiptKey(no, date));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Receipt;
  } catch {
    return null;
  }
}

export function saveReceipt(no: string, date: string, r: Receipt) {
  write(receiptKey(no, date), JSON.stringify(r));
}

export function getLastStudentNo(): string {
  const v = read(LAST_NO) ?? '';
  return STUDENT_NOS.has(v) ? v : '';
}

export function saveLastStudentNo(no: string) {
  write(LAST_NO, no);
}
