# 주말 자율 참여 제출 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 사용자 요청에 따라 기존 작업 폴더에서 구현과 테스트를 계속한다.

**Goal:** 세 주말의 신청자만 월요일에 토요일과 일요일 사진을 날짜별로 안전하게 제출한다.

**Architecture:** 기존 기간은 유지하고 `terms.submission_mode = 'weekend'`인 독립 기간을 만든다. `classes.public_term_id`로 공개 제출 기간을 지정하여 기존 10/2~12/31 기간과의 충돌을 제거한다. 날짜별 `public_submit_images` 및 이미지 검증을 재사용하며 두 날짜의 재시도 상태를 각각 관리한다.

**Tech Stack:** 기존 React, TypeScript, Supabase PostgreSQL, Edge Functions, private Storage, PGlite.

**Spec:** 이번 대화의 사용자 요구사항 1~11절. 아래 고정 계약과 제약으로 구현한다.

## Global Constraints

- 기존 프로젝트 직접 수정. 기존 데이터, 사진, 이력 삭제 금지. 원격 합성 제출 금지.
- 기록일 2026-11-21/22, 11-28/29, 12-05/06. 각 월요일 00:00 KST 개시, 기본 09:00 KST 마감.
- 최종 접수 종료 기본값 2026-12-08 00:00 KST 직전(12/7 지각 접수 허용). 교사에게 명시한다. 새 주말을 생성하지 않는다.
- 이미 열린 날짜의 개시와 마감 시각 변경 금지. 기존 일일 모드 유지.
- 참여 명단은 기간별, 공개 노출 금지. 전체 학생 active 변경 금지.
- 사진 날짜별 1~3장, requestId/token/시간/상태 분리. 성공한 날짜는 재시도에서 건너뛴다.
- 새 UI 가운데점 금지. 안전한 소스 문구와 문서의 기존 가운데점 정리.
- 실운영 변경 전 영향과 데이터 기준값 확인. 비밀키 및 개인정보 출력 금지.

## 고정 인터페이스

- `Term.submission_mode?: 'daily' | 'weekend'` (기존 fixture 호환, DB default daily)
- `ClassInfo.public_term_id?: string | null`
- `TeacherData.participantIds: string[]` (주말 기간의 참여 학생 ID, 명단 자체는 students 유지)
- `PublicInfo.term`에 `id?: string`, `submission_mode?: 'daily' | 'weekend'` 추가.
- `PublicInfo.open_days`는 주말 기간에서는 열린 6개 날짜 모두, daily에서는 기존 최근 7개.
- `Backend.saveWeekendTerm(classId, {termId, name, deadlineMinutes, instructions}): Promise<string>`
- `Backend.setPublicTerm(classId, termId: string | null): Promise<void>`
- `Backend.setTermParticipants(termId, studentIds: string[]): Promise<void>`
- RPC `save_weekend_term(p_class_id uuid,p_term_id uuid,p_name text,p_deadline_minutes integer,p_instructions text)`
- RPC `set_public_term(p_class_id uuid,p_term_id uuid)`
- RPC `set_term_participants(p_term_id uuid,p_student_ids uuid[])`
- DB `term_participants(term_id uuid, student_id uuid, active boolean, ...)`; 두 ID PK. 교사만 SELECT, 변경 RPC만 허용.
- 공개 제출은 선택 기간을 일관되게 사용. request_id 재사용 시 학생과 날짜의 일치 검증. 재시도도 참여 검증을 우회하지 않는다.

## Review Focus

1. 기존 기간과 주말 기간이 겹쳐도 공개 화면과 서버가 같은 기간을 선택하는지.
2. 응답 유실 후 파일/학번/주말이 바뀌거나 새로고침해도 requestId가 다른 날짜와 섞이지 않는지.
3. 제외된 참여자의 과거 사진 조회는 유지하되 미제출 통계에는 포함하지 않는지.
4. 한쪽 업로드 실패, 중복 클릭, 동시 요청, 토큰 재발급이 기존 사진을 손상하지 않는지.
5. 이미 열린 일정 변경 및 UI 대신 RPC 직접 호출로 비신청 제출을 우회할 수 없는지.

### Task 1: DB와 제출 계약

**Files:** 새 migration, `supabase/functions/submit/index.ts`, `_shared/util.ts`, `scripts/verify-weekend-db.mjs`.

- [x] 기존 스키마와 실제 migration 목록, 데이터 개수 및 지문 확인.
- [x] 로컬 PGlite 테스트 작성 후 기존 코드에서 실패 확인.
- [x] 고정 인터페이스의 스키마와 RPC 구현. 보호된 함수 권한, 기간 선택, 참가 검증, 날짜 바인딩, 마감 보존.
- [x] 기존 DB 검증 스크립트와 주말 검증 실행. 과거 행/사진/이력 보존 확인.
- [x] 변경 검토. 커밋 가능 여부 확인(현재 .git 쓰기는 환경에서 제한됨).

### Task 2: 공통 모델과 데모

**Files:** `src/lib/types.ts`, `backend/types.ts`, `backend/common.ts`, `backend/supabase.ts`, `backend/demo.ts`, `backend/demoData.ts`, `status.ts`, `weekend.ts`, 새 검증 스크립트.

- [x] 고정 계약과 정확한 6일 일정의 테스트 작성.
- [x] 실제 백엔드와 데모에 같은 인터페이스, 참여 필터, 공개 기간 선택 구현.
- [x] 정시/지각 경계와 일일 모드 회귀 검사.

### Task 3: 학생 제출 화면

**Files:** `PublicSubmit.tsx`, `WeekendSubmit.tsx`, `lib/weekendSubmit.ts`, `localReceipt.ts`, `styles.css`.

- [x] 두 날짜 독립 상태, 부분 성공과 실패 날짜만 재시도하는 검증 작성.
- [x] 기존 일일 화면 유지, 주말 UI 연결. 개별 미리보기와 제거, 확인창, 날짜별 접수 결과.
- [x] 실패 requestId 유지 및 응답 유실 복구, 동일 요청 중 파일 변경 방지.
- [x] 모바일 선택과 버튼 흐름 실제 확인.

### Task 4: 교사 화면, 검증, 적용

**Files:** `teacher/Settings.tsx`, `Roster.tsx`, `TeacherLayout.tsx`, `DayBoard.tsx`, `Overview.tsx`, `StudentDetail.tsx`, 새 주말 현황 화면, README.

- [x] 주말 기간 만들기/수정, 공개 기간 지정, 참여자 선택 저장.
- [x] 주말별 두 날짜 현황과 사진 비교, 참여자만 통계 반영, 기존 상세 검토 유지.
- [x] `npm run typecheck`, `npm run build`, 기존 로컬 검증 및 새 검증 모두 실행.
- [x] 코드 검토와 모바일 UI 확인, 배포 영향 분석, 기존 데이터 재검증.
- [x] 안전한 배포 수행 또는 환경상 불가능한 정확한 단계 보고. 신청자는 교사가 실제 명단을 선택하며 임의 등록하지 않는다.

## 작업 기록

- 기준 HEAD: d5aadb3. 작업 시작 시 변경 없음.
- 실제 DB: 제출 123, 이미지 행 151, 이벤트 130, Storage 객체 158. 기존 91개 날짜가 모두 수집 대상.
- 기존 remote 기간은 그대로 유지한다. 최초 공개 프로그램 활성화는 별도 RPC를 사용한다.
- 사용자 명시적 자율 구현 요청에 따라 설계 승인 질문은 생략한다.

## 최종 검증 기록

- Task 1~4 구현 완료. 기존 207개 검증과 주말 DB 24개, 추가 동작 검증 6개 스크립트, typecheck와 production build 통과.
- 검토에서 확인한 기간 변경 중 오접수, 기간별 토큰 충돌, 재진입 후 요청 번호 유실을 회귀 테스트로 재현한 뒤 수정했다.
- 390px 브라우저에서 두 날짜 사진 선택/삭제, 확인창, 부분 성공 및 재진입 복구를 확인했다. 교사 주말 현황은 선택한 2명만 표시했고 두 날짜 사진 비교를 확인했다.
- 사진 비교에서 발견한 가로 넘침은 기존 갤러리 스타일을 공유하도록 수정했다. 1280px에서 문서 너비와 표시 너비가 일치했다.
- 운영 migration `20261115184020_weekend_submission` 적용 및 submit Edge Function v6 배포. 기존 123개 제출, 151개 사진 행, 130개 이벤트, 158개 Storage 객체, 91개 기존 기록일과 학생 명단의 개수/행 지문이 변경 전후 일치했다.
- 로컬 `.git/index.lock` 쓰기 권한이 거절되어 소스와 Pages 커밋은 GitHub 연결을 사용한다. 로컬 Git HEAD/인덱스 동기화는 이 환경에서 수행할 수 없다.
- 서버 역할 전용 함수와 교사 권한 검사를 점검했다. 보안 advisor의 교사용 SECURITY DEFINER 호출 경고는 의도된 담당 교사 RPC에 대한 일반 경고이며, 기존 유출 비밀번호 보호 비활성 설정은 이번 범위에서 변경하지 않았다.
