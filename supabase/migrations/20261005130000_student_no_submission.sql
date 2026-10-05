-- 1-9 체크: 학생 계정 없이 학번만으로 제출
-- 원칙
--  * 학생 브라우저는 DB·Storage에 직접 쓰지 않는다. 제출은 공개 Edge Function(submit)이
--    서버 키로 이 파일의 public_submit()을 호출해서만 반영된다.
--  * anon은 여전히 어떤 테이블·함수·Storage 객체에도 권한이 없다.
--  * 학번은 서버에서 정확히 10901~10934만 허용하고, 공개 제출 대상 학급(public_submit)의 활성 명단과 대조한다.
--  * 이미 제출된 기록은 replacement token(원문은 저장하지 않고 SHA-256 hash만 저장)이 있거나
--    담임이 '다른 기기 재제출 허용'을 켠 경우에만 교체할 수 있다.
--  * 교사 Auth·RLS·관리 함수는 그대로 둔다.

-- ---------------------------------------------------------------------------
-- 컬럼
-- ---------------------------------------------------------------------------

-- 공개 제출을 받는 학급은 하나뿐이다.
alter table public.classes add column public_submit boolean not null default false;
create unique index classes_single_public_submit on public.classes ((true)) where public_submit;

alter table public.submissions
  add column replacement_token_hash text check (replacement_token_hash ~ '^[0-9a-f]{64}$'),
  -- 현재 token을 발급한 제출 요청(응답 유실 후 같은 요청 재시도 시 token을 다시 발급하기 위함)
  add column token_request_id uuid,
  -- 담임이 켜면 token 없이 한 번 교체할 수 있고, 교체한 기기에 새 token이 발급된다.
  add column resubmit_open boolean not null default false;

-- ---------------------------------------------------------------------------
-- 학생 세션 권한 제거
-- ---------------------------------------------------------------------------

-- 학생 계정은 더 이상 쓰지 않는다. 남아 있는 학생 Auth 계정으로 로그인해도 어떤 학급 자료도 볼 수 없다.
create or replace function app.current_student_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select null::uuid
$$;

-- 학생 직접 업로드 정책 제거(업로드는 Edge Function이 서버 키로만 한다).
drop policy if exists screenshots_student_insert on storage.objects;

-- 이미지 경로: 기존 {학생 auth uid}/{term}/{uuid}.ext 또는 신규 {students.id}/{term}/{uuid}.ext
-- 조회는 담당 교사만.
create or replace function app.can_read_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.students s
    where (s.id::text = split_part(p_name, '/', 1) or s.user_id::text = split_part(p_name, '/', 1))
      and app.is_class_teacher(s.class_id)
  )
$$;

revoke execute on function public.submit_excuse(uuid, date, text, text) from authenticated;

-- replacement token hash·발급 요청 ID는 서버 함수만 읽는다(교사 세션도 조회 불가).
revoke select on public.submissions from authenticated;
grant select (id, term_id, student_id, record_date, image_path, image_version, image_mime, image_bytes,
              first_submitted_at, image_updated_at, self_minutes, student_note, review_status,
              reviewed_version, revision_message, reviewed_at, reviewed_by, resubmit_open)
  on public.submissions to authenticated;

-- ---------------------------------------------------------------------------
-- 공개 제출 (service_role 전용 — 공개 Edge Function만 호출)
-- ---------------------------------------------------------------------------

-- 학번 → 공개 제출 학급의 활성 학생. 범위 밖이거나 명단에 없으면 같은 코드로 거절한다.
create or replace function app.public_student(p_student_no text)
returns public.students language plpgsql stable security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
begin
  if p_student_no is null or p_student_no !~ '^109(0[1-9]|[12][0-9]|3[0-4])$' then
    raise exception 'invalid_student_no';
  end if;
  select s.* into v_student
  from public.students s join public.classes c on c.id = s.class_id
  where c.public_submit and s.student_no = p_student_no and s.active;
  if not found then raise exception 'invalid_student_no'; end if;
  return v_student;
end
$$;
revoke all on function app.public_student(text) from public, anon, authenticated;
grant execute on function app.public_student(text) to service_role;

-- 결과 형식(재시도·최초·교체 공통)
create or replace function app.public_result(
  p_sub public.submissions, p_replayed boolean, p_replaced boolean, p_token_issued boolean
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    'replaced', p_replaced,
    'token_issued', p_token_issued,
    'record_date', p_sub.record_date,
    'version', p_sub.image_version,
    'first_submitted_at', p_sub.first_submitted_at,
    'deadline_at', d.deadline_at,
    'late', p_sub.first_submitted_at > d.deadline_at)
  from public.term_days d
  where d.term_id = p_sub.term_id and d.record_date = p_sub.record_date
$$;
revoke all on function app.public_result(public.submissions, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function app.public_result(public.submissions, boolean, boolean, boolean) to service_role;

-- 학번 제출.
--  p_object_path = null : 사전 확인(아무것도 쓰지 않음). 같은 요청의 재시도면 재시도 결과를 돌려준다.
--                         통과하면 {ready, student_id, term_id} → Edge Function이 그 경로로 업로드한다.
--  p_object_path 지정   : 같은 검사를 잠금과 함께 다시 하고 한 트랜잭션으로 반영한다.
--  p_token_hash         : 학생 기기에 저장된 replacement token의 SHA-256(hex). 없으면 null.
--  p_new_token_hash     : 이번에 token을 발급하게 되면 저장할 새 token의 SHA-256(hex).
--                         원문 token은 Edge Function이 응답으로만 돌려주고 DB에는 저장하지 않는다.
create or replace function public.public_submit(
  p_student_no text, p_record_date date, p_request_id uuid,
  p_token_hash text, p_new_token_hash text,
  p_object_path text, p_mime text, p_bytes integer, p_self_minutes integer, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
  v_day public.term_days%rowtype;
  v_sub public.submissions%rowtype;
  v_event public.submission_events%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_now timestamptz := now();
  v_replace_ok boolean;
  v_via_open boolean;
begin
  if p_request_id is null or p_record_date is null
     or p_new_token_hash is null or p_new_token_hash !~ '^[0-9a-f]{64}$'
     or (p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'bad_request';
  end if;

  v_student := app.public_student(p_student_no);

  -- 같은 요청의 재시도(응답 유실): 아무것도 새로 만들지 않고 처음 결과를 돌려준다.
  -- 그 요청이 token을 발급한 요청이면 응답을 못 받은 기기를 위해 token만 새로 발급(교체)한다.
  select * into v_event from public.submission_events where request_id = p_request_id;
  if found then
    if v_event.student_id <> v_student.id then raise exception 'bad_request'; end if;
    select * into v_sub from public.submissions where id = v_event.submission_id for update;
    if v_sub.token_request_id = p_request_id then
      update public.submissions set replacement_token_hash = p_new_token_hash
      where id = v_sub.id returning * into v_sub;
      return app.public_result(v_sub, true, v_event.version > 1, true);
    end if;
    return app.public_result(v_sub, true, v_event.version > 1, false);
  end if;

  select d.* into v_day
  from public.term_days d join public.terms t on t.id = d.term_id
  where t.class_id = v_student.class_id and d.record_date = p_record_date
  order by t.start_date desc
  limit 1;
  if not found then raise exception 'date_out_of_range'; end if;
  -- 운영 기간·대상일·명단 범위·제출 창(다음 날 00:00 이후, 마지막 허용 시각 이전)
  v_day := app.assert_submittable(v_student.id, v_day.term_id, p_record_date);

  if p_self_minutes is not null and p_self_minutes not between 0 and 1440 then
    raise exception 'bad_minutes';
  end if;
  if char_length(v_note) > 100 then raise exception 'note_too_long'; end if;

  if p_object_path is null then
    select * into v_sub from public.submissions
    where term_id = v_day.term_id and student_id = v_student.id and record_date = p_record_date;
  else
    if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'bad_type'; end if;
    if p_bytes is null or p_bytes <= 0 or p_bytes > 2097152 then raise exception 'too_large'; end if;
    if p_object_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
       or split_part(p_object_path, '/', 1) <> v_student.id::text
       or split_part(p_object_path, '/', 2) <> v_day.term_id::text then
      raise exception 'bad_path';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'screenshots' and o.name = p_object_path) then
      raise exception 'object_missing';
    end if;
    if exists (select 1 from public.submission_events where image_path = p_object_path) then
      raise exception 'path_reused';
    end if;
    select * into v_sub from public.submissions
    where term_id = v_day.term_id and student_id = v_student.id and record_date = p_record_date
    for update;
    -- 잠금을 기다리는 동안 같은 요청이 먼저 반영됐을 수 있다
    if exists (select 1 from public.submission_events where request_id = p_request_id) then
      return public.public_submit(p_student_no, p_record_date, p_request_id, p_token_hash, p_new_token_hash,
                                  null, null, null, null, null);
    end if;
  end if;

  if v_sub.id is not null then
    v_replace_ok := (p_token_hash is not null and v_sub.replacement_token_hash = p_token_hash);
    v_via_open := not v_replace_ok and v_sub.resubmit_open;
    if not v_replace_ok and not v_via_open then raise exception 'already_submitted'; end if;
  end if;

  if p_object_path is null then
    return jsonb_build_object('ready', true, 'student_id', v_student.id, 'term_id', v_day.term_id,
                              'replace', v_sub.id is not null);
  end if;

  if v_sub.id is null then
    begin
      insert into public.submissions (
        term_id, student_id, record_date, image_path, image_version, image_mime, image_bytes,
        first_submitted_at, image_updated_at, self_minutes, student_note,
        replacement_token_hash, token_request_id)
      values (v_day.term_id, v_student.id, p_record_date, p_object_path, 1, p_mime, p_bytes,
              v_now, v_now, p_self_minutes, v_note, p_new_token_hash, p_request_id)
      returning * into v_sub;
    exception when unique_violation then
      -- 다른 요청이 먼저 첫 제출을 마쳤다. 같은 요청이면 재시도 결과, 아니면 이미 제출됨.
      if exists (select 1 from public.submission_events where request_id = p_request_id) then
        return public.public_submit(p_student_no, p_record_date, p_request_id, p_token_hash, p_new_token_hash,
                                    null, null, null, null, null);
      end if;
      raise exception 'already_submitted';
    end;
    insert into public.submission_events (request_id, submission_id, student_id, version, image_path)
    values (p_request_id, v_sub.id, v_student.id, 1, p_object_path);
    return app.public_result(v_sub, false, false, true);
  end if;

  -- 교체: 최초 접수 시각·정시/지각 판정 유지, 버전 증가, 교사 확인은 미확인으로.
  update public.submissions
  set image_path = p_object_path,
      image_version = v_sub.image_version + 1,
      image_mime = p_mime,
      image_bytes = p_bytes,
      image_updated_at = v_now,
      self_minutes = p_self_minutes,
      student_note = v_note,
      review_status = 'unchecked',
      reviewed_version = null,
      reviewed_at = null,
      reviewed_by = null,
      replacement_token_hash = case when v_via_open then p_new_token_hash else replacement_token_hash end,
      token_request_id = case when v_via_open then p_request_id else token_request_id end,
      resubmit_open = false
  where id = v_sub.id
  returning * into v_sub;
  insert into public.submission_events (request_id, submission_id, student_id, version, image_path)
  values (p_request_id, v_sub.id, v_student.id, v_sub.image_version, p_object_path);
  return app.public_result(v_sub, false, true, v_via_open);
end
$$;

-- 공개 제출 화면에 필요한 일정만(학생 이름·제출 현황 없음).
create or replace function public.public_info()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_class public.classes%rowtype;
  v_term public.terms%rowtype;
  v_now timestamptz := now();
begin
  select * into v_class from public.classes where public_submit;
  if not found then
    return jsonb_build_object('server_now', v_now, 'ready', false);
  end if;
  select * into v_term from public.terms
  where class_id = v_class.id and final_close_at >= v_now
  order by start_date
  limit 1;
  return jsonb_build_object(
    'server_now', v_now,
    'ready', true,
    'app_title', v_class.app_title,
    'app_subtitle', v_class.app_subtitle,
    'term', case when v_term.id is null then null else jsonb_build_object(
      'name', v_term.name, 'instructions', v_term.instructions, 'final_close_at', v_term.final_close_at) end,
    -- 지금 제출할 수 있는 대상일(최근 7일, 최신순)
    'open_days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'record_date', d.record_date, 'window_open_at', d.window_open_at, 'deadline_at', d.deadline_at)
        order by d.record_date desc)
      from (select * from public.term_days
            where term_id = v_term.id and is_target and window_open_at <= v_now
            order by record_date desc limit 7) d), '[]'::jsonb),
    'next_day', (
      select jsonb_build_object(
        'record_date', d.record_date, 'window_open_at', d.window_open_at, 'deadline_at', d.deadline_at)
      from public.term_days d
      where d.term_id = v_term.id and d.is_target and d.window_open_at > v_now
      order by d.record_date
      limit 1));
end
$$;

-- ---------------------------------------------------------------------------
-- 교사: 다른 기기 재제출 허용
-- ---------------------------------------------------------------------------

create or replace function public.allow_resubmission(p_submission_id uuid, p_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.submissions%rowtype;
begin
  select * into v_sub from public.submissions where id = p_submission_id for update;
  if not found or not app.is_student_teacher(v_sub.student_id) then raise exception 'not_allowed'; end if;
  update public.submissions set resubmit_open = coalesce(p_open, false) where id = p_submission_id;
  return jsonb_build_object('id', p_submission_id, 'resubmit_open', coalesce(p_open, false));
end
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: 기본(PUBLIC·anon) 회수 후 명시 부여
-- ---------------------------------------------------------------------------

revoke all on function public.public_submit(text, date, uuid, text, text, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.public_info() from public, anon, authenticated;
revoke all on function public.allow_resubmission(uuid, boolean) from public, anon;
grant execute on function public.public_submit(text, date, uuid, text, text, text, text, integer, integer, text) to service_role;
grant execute on function public.public_info() to service_role;
grant execute on function public.allow_resubmission(uuid, boolean) to authenticated;
