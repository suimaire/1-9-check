# 1-9 체크

1학년 9반(34명) 시험기간 스크린타임 제출 시스템입니다.
학생은 **계정 없이** 학번(10901~10934)을 입력하고 전날 스크린타임 사진을 **하루 1~3장** 제출합니다(1번 사진은 하루 전체 사용 시간 화면 권장).
담임은 별도 교사 화면에서 로그인해 날짜별 제출 현황을 확인하고 개별 지도합니다.
사용 시간을 점수·순위·위험 판정으로 바꾸지 않고, 앱을 학습/비학습으로 자동 분류하지 않으며, OCR·AI 분석도 하지 않습니다.
사진은 **파일 접수**일 뿐이고, 담임이 원본 사진을 직접 보고 날짜별로 비교합니다(총 사용 시간 입력은 선택 참고값).

- 공개 주소: https://suimaire.github.io/1-9-check/ (학생 제출) · https://suimaire.github.io/1-9-check/#/teacher (담임)
- 프런트엔드: React + TypeScript + Vite (GitHub Pages 정적 호스팅, HashRouter)
- 서버: Supabase(project ref `gxylwcqhrmadwgjglras`) — 교사 Auth · Postgres(RLS) · private Storage · Edge Functions

## 구조

```
학생 브라우저 ── 학번 + 사진 1~3장(files) + 기록 날짜 ──▶ submit (공개 Edge Function, verify_jwt=false)
                                              ├ 학번 허용 목록(10901~10934) + 활성 명단 확인
                                              ├ 날짜·운영 기간·제출 창 확인 (KST)
                                              ├ 장수(1~3) + 사진마다 MIME·확장자·시그니처·크기(장당 2MB) 확인
                                              ├ 기존 제출 / replacement token 확인
                                              ├ Storage 업로드(서버 키, private 버킷) — 하나라도 실패하면 올린 것 삭제
                                              └ DB 한 트랜잭션 반영(public_submit_images, service_role 전용)
담임 브라우저 ── 교사 로그인(Supabase Auth) ──▶ RLS로 담당 학급만 조회 · teacher-admin(교사 JWT 확인)
```

- 학생 브라우저에는 publishable key만 있습니다. 학생 화면은 DB·Storage에 직접 `insert`/`upload` 하지 않습니다.
- `anon`은 어떤 테이블·RPC·Storage 객체에도 권한이 없습니다. `screenshots` 버킷은 private입니다.
- `verify_jwt=false`는 보안 장치가 아닙니다. 모든 검증은 `submit` 함수와 DB 함수 `public_submit_images()`에서 합니다. CORS도 인증 수단이 아닙니다.
- 공개 화면은 학번으로 학생 이름이나 제출 여부를 조회하지 않습니다. "이미 냈음" 표시는 같은 기기에 저장한 기록(localStorage)으로만 보여 줍니다.

## 제출 규칙

- 기록 대상: 전날 하루 전체. 기록일 D는 D+1 00:00(KST)에 제출 창이 열리고 기본 마감 D+1 08:00.
  마감 전 미제출은 '제출 대기', 마감 후 미제출은 '미제출', 제출은 '정시 접수'/'지각 접수'.
- 첫 제출에 성공하면 서버가 무작위 **replacement token**(256비트)을 발급합니다. 원문은 응답으로만 학생 기기에 전달되어
  `localStorage`의 `1-9-check:replacement-token:{학번}:{기록일}`에 저장되고, DB에는 SHA-256 hash만 저장됩니다(교사 세션도 조회 불가).
- 하루 기록 1개 = **사진 세트** 1개(`submissions` 1행 → `submission_images` 1~3행). token·`request_id`·버전·최초 접수 시각·정시/지각은
  사진 한 장이 아니라 사진 세트 전체에 적용됩니다. 업로드·반영 중 하나라도 실패하면 아무것도 반영하지 않습니다(부분 제출 없음).
- 같은 학번·날짜에 이미 제출이 있으면, 이 token이 맞을 때만 **사진 세트 전체**가 새 사진으로 교체됩니다(이전 버전 행은 이력으로 남고 화면에는 현재 버전만).
  교체 시 최초 접수 시각·정시/지각 판정은 유지되고, 버전이 오르며, 교사 확인 상태는 '미확인'으로 돌아갑니다.
  token이 없거나 틀리면 "이미 제출된 기록입니다. 다른 기기에서 수정하려면 담임교사에게 알려 주세요."로 거절합니다.
- 다른 기기에서 다시 내야 하면 담임이 교사 화면의 제출 칸에서 **재제출 허용**을 켭니다. 다음 1회 제출이 교체로 반영되고
  그 기기에 새 token이 발급되며, 허용은 자동으로 꺼집니다(이전 token은 무효).
- 네트워크 응답이 끊겨 같은 요청(`request_id`)이 다시 와도 행·Storage 객체를 새로 만들지 않고 처음 결과를 돌려줍니다.
  token을 발급한 요청의 재시도면 응답을 못 받은 기기를 위해 token만 새로 발급합니다.
- 같은 IP에서 15분에 120회를 넘는 제출 요청은 거절합니다(학교 와이파이 34명 기준 여유).

## 무계정 제출의 구조적 한계 (버그 아님)

학생 인증이 없으므로 **다른 사람이 특정 학번으로 최초 제출하는 행위를 기술적으로 완전히 방지할 수 없습니다.**
학번만 알면 아직 제출되지 않은 날짜에 대신 제출할 수 있고, 그 기기가 token을 갖게 됩니다.
이미 제출된 기록을 학번만으로 덮어쓰는 것은 막습니다(token 또는 담임 허용 필요). 담임이 재제출 허용을 켠 동안에는 학번만으로 교체될 수 있으므로 필요할 때만 켭니다.

문제가 생기면 학생별 개인 PIN, 일회성 코드, 계정 로그인 중 하나를 추가하는 것으로 해결할 수 있습니다(이번 단계에서는 구현하지 않음).
학생 제출 화면에는 이 경고를 따로 표시하지 않습니다.

## 화면

| 화면 | 경로 |
|---|---|
| 학생 제출 (로그인 없음) | `/#/` |
| 담임 로그인 | `/#/teacher` (로그인 전이면 `/#/teacher/login`) |
| 날짜별 현황 / 기간 한눈에 | `/#/teacher`, `/#/teacher/overview` |
| 학생 상세 / 명단 / 운영 설정 | `/#/teacher/students/:id`, `/#/teacher/roster`, `/#/teacher/settings` |

교사 화면: 날짜별 현황(사진 N장 표시), 기간 한눈에, 학생별 제출, 사진 세트 확인(큰 사진 + 썸네일, 이전/다음),
**학생 상세 › 사용 기록 비교**(최근 7일/14일 원본 사진을 날짜별로 나란히, 미제출·면제 날짜도 빈 칸으로 유지, 사진을 누르면 크게 보기 —
사진은 학생 상세에서 화면에 보이는 칸만 내려받음), 수정 요청(학생 화면에는 표시되지 않으니 직접 전달), 면제, 교사용 메모, 연속 미제출, 재제출 허용.
명단은 학번·표시명·활성 여부만 관리합니다(학생 계정·비밀번호 기능 없음). 표시명은 교사 화면에만 보입니다.

## 실행 모드

| 모드 | 실행 | 동작 |
|---|---|---|
| `demo` | `npm run dev:demo` | 서버 없음. 합성 학생 34명·합성 이미지, 시각/실패 시뮬레이션 |
| `supabase` | `.env.local`에 `VITE_APP_MODE=supabase` + URL + publishable key → `npm run dev` | 실제 연결 |

- 실연결 로컬 확인은 4320 포트(`.claude/launch.json`의 `1-9-check-live`) — Edge Function 허용 origin에 들어 있습니다.
- dev 서버의 base는 `/`, `npm run build`의 base는 `/1-9-check/`(다른 경로면 `VITE_BASE_PATH`로 덮어쓰기).
- supabase 모드인데 URL/key가 없거나 publishable key 자리에 `sb_secret_...`가 있으면 설정 오류 화면에서 멈춥니다.

## Supabase 설정

```powershell
Set-Location "D:\Codex\screentimecheck"
npx supabase link --project-ref gxylwcqhrmadwgjglras
npx supabase db push                     # 새 migration만 적용(원격 reset 금지)
npx supabase secrets set ALLOWED_ORIGINS=http://localhost:4320,http://127.0.0.1:4320,https://suimaire.github.io
npx supabase functions deploy submit --no-verify-jwt
npx supabase functions deploy teacher-admin --no-verify-jwt
npx supabase functions deploy login-resolve --no-verify-jwt
npx supabase functions deploy account --no-verify-jwt
```

- `submit`: 공개 학번 제출(로그인 없음). `teacher-admin`·`account`: 함수 안에서 교사 JWT를 Auth 서버로 검증.
  `login-resolve`: 교사 ID → 내부 이메일 별칭(로그인 전 호출).
- Auth: 공개 가입(sign-up) OFF 유지. 교사는 비밀번호 로그인만 쓰고 redirect/OAuth를 쓰지 않으므로 Site URL·redirect 설정은 필요 없습니다.
- 공개 제출 학급 지정과 학번 등록: `npm run setup:class -- --deactivate-others`
  (학급 하나를 `public_submit`으로 지정, 10901~10934 등록(표시명 '학생 01'~), 범위 밖 학번 비활성화. 기존 표시명은 바꾸지 않음)
- 실제 이름은 교사 화면 › 명단 › '명단 가져오기·표시명 바꾸기'에 `학번, 표시명`을 붙여넣어 바꿉니다.

### migration

| 파일 | 내용 |
|---|---|
| `20261005000000_haru_check.sql` | 초기 스키마(원격 적용됨 — 수정 금지) |
| `20261005130000_student_no_submission.sql` | 학번 제출: `classes.public_submit`, token hash 컬럼, `public_submit()`/`public_info()`(service_role 전용), `allow_resubmission()`(교사), 학생 세션 권한·학생 업로드 정책 제거, token hash 컬럼 조회 차단 |
| `20261007000000_submission_images.sql` | 사진 세트: `submission_images`(교사 조회 RLS, 쓰기는 service_role 함수만), 기존 단일 사진 backfill(`submissions.image_path` 등 예전 컬럼은 유지 — 1번 사진 값을 계속 기록), `public_submit_images()`, 예전 `public_submit()`은 1장 세트로 위임, 정리 대상 함수가 현재 버전 사진 세트를 보존 |

## 최초 교사 계정

공개 가입·관리자 생성 페이지는 없습니다. 운영자 PC에서 `.env.server`(커밋 금지)에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ALIAS_EMAIL_DOMAIN`을 넣고:

```powershell
npm run bootstrap:teacher -- --login-id t10900 --name "담임" --class "1학년 9반"
```

임시 비밀번호가 한 번만 출력되고, 첫 로그인 때 비밀번호를 바꿔야 학급 자료에 접근할 수 있습니다.

## GitHub Pages 배포

```powershell
npm run build          # .env.local의 공개 값(URL, publishable key)으로 빌드, base /1-9-check/
npm run deploy:pages   # dist → gh-pages 브랜치 (secret key가 보이면 중단)
```

Pages 소스는 `gh-pages` 브랜치 루트입니다. (GitHub Actions 배포로 바꾸려면 gh 토큰에 `workflow` 권한이 필요합니다.)

## 확인 스크립트

```powershell
npm run verify:public-db     # 학번 제출 계약(PGlite, 두 migration 적용) — anon 차단·학번·token·재시도·재제출 허용
npm run verify:images-db     # 사진 세트(PGlite, 세 migration) — backfill·권한·1~3장 검증·부분 실패·재제출·재시도·정리 대상
npm run verify:images-payload  # submit 파일 검증(1~3장, 장당 2MB·MIME·서명)과 예전 1장 기록 호환
npm run verify:images-live   # 실제 프로젝트 읽기 전용: backfill·교사 사진 세트 조회·anon 차단 (제출을 만들지 않음)
npm run verify:public-live   # 실제 프로젝트: 공개 제출·교사 반영·anon DB/Storage 차단·token 교체 (합성 이미지)
npm run verify:status        # KST 마감·집계 규칙
npm run verify:db            # 초기 migration 기준 접근권한(학생 계정 시절 계약)
```

`verify:public-live`는 기본으로 10901의 가장 최근 제출 가능일에 합성 이미지를 냅니다(`--student 10902 --date 2026-10-04`로 변경).

## 현재 TEST 자료와 정리

지금 원격에는 합성 자료만 있습니다: 교사 `TST-TEACHER`, 예전 학생 Auth 계정 `TST001`~`TST003`(사용하지 않음, 명단에서 비활성), `[TEST] 공개 배포 테스트 기간`(10/2~10/31), 10901·10902의 합성 이미지 제출.
자격 증명은 `verification.local/live-supabase-e2e/TEST_CREDENTIALS.txt`(커밋 금지)에만 있습니다. 자동 삭제하지 않습니다. 실제 운영 전에:

1. 교사 화면 › 운영 설정 › `[TEST] 공개 배포 테스트 기간` **자료 삭제**(Storage → DB 순)
2. Supabase 대시보드 › Authentication › Users에서 TEST 계정 삭제(SQL Editor: `select login_id, user_id from public.login_aliases where login_id like 'tst%';`로 user_id 확인)
3. SQL Editor: `delete from public.students where student_no like 'TST%';`
4. 실제 운영 기간을 만들고 실제 교사 계정을 준비한 뒤 `TEST_CREDENTIALS.txt` 삭제

## 저장소에 넣지 않는 것

`.env.local`, `.env.server`, `supabase/functions/.env`, `verification.local/`(자격 증명·DB 비밀번호·스크린샷), 실제 학생 명단, 이미지. (`.gitignore`)

## 범위에서 제외

학생 계정·PIN, OCR, 생성형 AI, 휴대폰 자동 감시·앱 차단, 부모 계정, 푸시·문자·메일 발송, 결제, 배지·포인트, 자동 삭제 스케줄러, 오프라인 저장.
