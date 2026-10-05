// CSV 가져오기/내보내기 도구

/** 쉼표 또는 탭 구분 텍스트 파싱(따옴표 지원) */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = clean.split('\n', 1)[0] ?? '';
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

export interface RosterLine {
  line: number;
  student_no: string;
  name: string;
  problem: string | null;
}

/** 명단 붙여넣기/CSV: '학번(또는 번호), 이름' 두 열. 머리글 행은 자동으로 건너뛴다. */
export function parseRoster(text: string): RosterLine[] {
  const rows = parseDelimited(text);
  if (rows.length && /학번|번호|이름|name|no/i.test(rows[0].join(' ')) && !/^\d/.test(rows[0][0] ?? '')) rows.shift();
  const seen = new Map<string, number>();
  return rows.map((r, i) => {
    const student_no = (r[0] ?? '').replace(/\s/g, '');
    const name = (r[1] ?? '').trim();
    let problem: string | null = null;
    if (!student_no) problem = '학번 누락';
    else if (!/^[0-9A-Za-z-]{1,20}$/.test(student_no)) problem = '학번 형식 오류';
    else if (!name) problem = '이름 누락';
    else if (name.length > 30) problem = '이름이 너무 김';
    else if (seen.has(student_no)) problem = `중복(${seen.get(student_no)}행과 같은 학번)`;
    if (student_no && !seen.has(student_no)) seen.set(student_no, i + 1);
    return { line: i + 1, student_no, name, problem };
  });
}

/** 수식 삽입 방지: =, +, -, @, 탭, CR로 시작하는 값 앞에 작은따옴표 */
function safeCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel 호환: UTF-8 BOM + CRLF */
export function toCsv(rows: unknown[][]): Blob {
  const body = rows.map((r) => r.map(safeCell).join(',')).join('\r\n');
  return new Blob(['﻿' + body + '\r\n'], { type: 'text/csv;charset=utf-8' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
