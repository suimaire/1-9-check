-- 1-9 체크: 하루 기록(submission) 1개에 사진 1~3장
-- 원칙
--  * submission 1개 → submission_images 1~3행(사진 세트). 버전(image_version)·replacement token·request_id·
--    최초 접수 시각·정시/지각 판정은 사진 한 장이 아니라 submission(사진 세트) 전체에 적용한다.
--  * 재제출은 사진 세트 전체 교체: 새 버전의 1~3행을 넣고, 이전 버전 행은 이력으로 남긴다(조회는 현재 버전만).
--  * 기존 submissions.image_path·image_mime·image_bytes는 지우지 않는다. 새 제출에서도 1번 사진 값을 함께 기록해
--    예전 화면·함수가 계속 동작하게 한다(호환용).
--  * 학생(anon)은 여전히 어떤 테이블·Storage에도 직접 접근하지 않는다. 쓰기는 service_role 함수로만.
--  * 기존 migration은 수정하지 않는다. 이미 접수된 단일 사진 제출은 1장짜리 사진 세트로 옮겨 적는다(backfill).

-- ---------------------------------------------------------------------------
-- 사진 세트
-- ---------------------------------------------------------------------------

create table public.submission_images (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  image_version integer not null check (image_version >= 1),
  sort_order smallint not null check (sort_order between 1 and 3),
  storage_path text not null unique,
  image_mime text not null check (image_mime in ('image/jpeg', 'image/png', 'image/webp')),
  image_bytes integer not null check (image_bytes > 0 and image_bytes <= 2097152),
  created_at timestamptz not null default now(),
  unique (submission_id, image_version, sort_order)
);

alter table public.submission_images enable row level security;

-- 교사: 담당 학생의 사진 목록만 조회. 학생·anon 정책 없음. 쓰기 정책 없음(service_role 함수 전용).
create policy submission_images_select on public.submission_images for select to authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_images.submission_id and app.is_student_teacher(s.student_id)
  ));

revoke all on public.submission_images from public, anon, authenticated;
grant select on public.submission_images to authenticated;

-- 기존 단일 사진 제출 → 현재 버전의 1번 사진으로 옮겨 적기(원본 컬럼은 그대로 둔다)
insert into public.submission_images (submission_id, image_version, sort_order, storage_path, image_mime, image_bytes, created_at)
select s.id, s.image_version, 1, s.image_path, s.image_mime, s.image_bytes, s.image_updated_at
from public.submissions s
where s.image_path is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 제출 결과에 사진 수 포함
-- ---------------------------------------------------------------------------

create or replace function app.public_result(
  p_sub public.submissions, p_replayed boolean, p_replaced boolean, p_token_issued boolean
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    'replaced', p_replaced,
    'token_issued', p_token_issued,
    'record_date', p_sub.record_date,
    'version', p_sub.image_version,
    'image_count', (select count(*) from public.submission_images i
                    where i.submission_id = p_sub.id and i.image_version = p_sub.image_version),
    'first_submitted_at', p_sub.first_submitted_at,
    'deadline_at', d.deadline_at,
    'late', p_sub.first_submitted_at > d.deadline_at)
  from public.term_days d
  where d.term_id = p_sub.term_id and d.record_date = p_sub.record_date
$$;

-- ---------------------------------------------------------------------------
-- 사진 세트 제출 (service_role 전용 — 공개 Edge Function만 호출)
-- ---------------------------------------------------------------------------

-- p_images = null : 사전 확인(아무것도 쓰지 않음). 같은 요청의 재시도면 재시도 결과를 돌려준다.
-- p_images = [{path, mime, bytes}, ...] (1~3개, 배열 순서 = 사진 순서)
--           : 업로드된 객체를 모두 확인한 뒤 한 트랜잭션으로 submission + 사진 행 + 이벤트를 반영한다.
--             하나라도 문제가 있으면 아무것도 반영하지 않는다(부분 제출 없음).
-- 나머지 인자·token·재시도 규칙은 public_submit()과 같다.
create or replace function public.public_submit_images(
  p_student_no text, p_record_date date, p_request_id uuid,
  p_token_hash text, p_new_token_hash text,
  p_images jsonb, p_self_minutes integer, p_note text
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
  v_img jsonb;
  v_path text;
  v_mime text;
  v_count integer;
  v_first jsonb;
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
  v_day := app.assert_submittable(v_student.id, v_day.term_id, p_record_date);

  if p_self_minutes is not null and p_self_minutes not between 0 and 1440 then
    raise exception 'bad_minutes';
  end if;
  if char_length(v_note) > 100 then raise exception 'note_too_long'; end if;

  if p_images is null then
    select * into v_sub from public.submissions
    where term_id = v_day.term_id and student_id = v_student.id and record_date = p_record_date;
  else
    if jsonb_typeof(p_images) <> 'array' then raise exception 'bad_request'; end if;
    v_count := jsonb_array_length(p_images);
    if v_count < 1 then raise exception 'no_image'; end if;
    if v_count > 3 then raise exception 'too_many_images'; end if;
    for v_img in select value from jsonb_array_elements(p_images) loop
      if jsonb_typeof(v_img) <> 'object' then raise exception 'bad_request'; end if;
      v_path := coalesce(v_img ->> 'path', '');
      v_mime := coalesce(v_img ->> 'mime', '');
      if v_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'bad_type'; end if;
      if coalesce(v_img ->> 'bytes', '') !~ '^[0-9]{1,9}$'
         or (v_img ->> 'bytes')::integer <= 0 or (v_img ->> 'bytes')::integer > 2097152 then
        raise exception 'too_large';
      end if;
      if v_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
         or split_part(v_path, '/', 1) <> v_student.id::text
         or split_part(v_path, '/', 2) <> v_day.term_id::text
         or substring(v_path from '\.([a-z]+)$') <> (case v_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end) then
        raise exception 'bad_path';
      end if;
      if not exists (select 1 from storage.objects o where o.bucket_id = 'screenshots' and o.name = v_path) then
        raise exception 'object_missing';
      end if;
      if exists (select 1 from public.submission_events where image_path = v_path)
         or exists (select 1 from public.submission_images where storage_path = v_path)
         or exists (select 1 from public.submissions where image_path = v_path) then
        raise exception 'path_reused';
      end if;
    end loop;
    if (select count(distinct value ->> 'path') from jsonb_array_elements(p_images)) <> v_count then
      raise exception 'bad_path';
    end if;
    v_first := p_images -> 0;

    select * into v_sub from public.submissions
    where term_id = v_day.term_id and student_id = v_student.id and record_date = p_record_date
    for update;
    -- 잠금을 기다리는 동안 같은 요청이 먼저 반영됐을 수 있다
    if exists (select 1 from public.submission_events where request_id = p_request_id) then
      return public.public_submit_images(p_student_no, p_record_date, p_request_id, p_token_hash, p_new_token_hash,
                                         null, null, null);
    end if;
  end if;

  if v_sub.id is not null then
    v_replace_ok := (p_token_hash is not null and v_sub.replacement_token_hash = p_token_hash);
    v_via_open := not v_replace_ok and v_sub.resubmit_open;
    if not v_replace_ok and not v_via_open then raise exception 'already_submitted'; end if;
  end if;

  if p_images is null then
    return jsonb_build_object('ready', true, 'student_id', v_student.id, 'term_id', v_day.term_id,
                              'replace', v_sub.id is not null);
  end if;

  if v_sub.id is null then
    begin
      insert into public.submissions (
        term_id, student_id, record_date, image_path, image_version, image_mime, image_bytes,
        first_submitted_at, image_updated_at, self_minutes, student_note,
        replacement_token_hash, token_request_id)
      values (v_day.term_id, v_student.id, p_record_date, v_first ->> 'path', 1, v_first ->> 'mime',
              (v_first ->> 'bytes')::integer, v_now, v_now, p_self_minutes, v_note, p_new_token_hash, p_request_id)
      returning * into v_sub;
    exception when unique_violation then
      -- 다른 요청이 먼저 첫 제출을 마쳤다. 같은 요청이면 재시도 결과, 아니면 이미 제출됨.
      if exists (select 1 from public.submission_events where request_id = p_request_id) then
        return public.public_submit_images(p_student_no, p_record_date, p_request_id, p_token_hash, p_new_token_hash,
                                           null, null, null);
      end if;
      raise exception 'already_submitted';
    end;
  else
    -- 교체: 최초 접수 시각·정시/지각 판정 유지, 버전 증가, 교사 확인은 미확인으로.
    update public.submissions
    set image_path = v_first ->> 'path',
        image_version = v_sub.image_version + 1,
        image_mime = v_first ->> 'mime',
        image_bytes = (v_first ->> 'bytes')::integer,
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
  end if;

  insert into public.submission_images (submission_id, image_version, sort_order, storage_path, image_mime, image_bytes, created_at)
  select v_sub.id, v_sub.image_version, e.ord, e.value ->> 'path', e.value ->> 'mime', (e.value ->> 'bytes')::integer, v_now
  from jsonb_array_elements(p_images) with ordinality as e(value, ord);

  insert into public.submission_events (request_id, submission_id, student_id, version, image_path)
  values (p_request_id, v_sub.id, v_student.id, v_sub.image_version, v_first ->> 'path');

  if v_sub.image_version = 1 then
    return app.public_result(v_sub, false, false, true);
  end if;
  return app.public_result(v_sub, false, true, v_via_open);
end
$$;

-- 예전 단일 사진 계약(배포 전환 중 이전 submit 함수가 부를 수 있음) → 1장짜리 사진 세트로 처리
create or replace function public.public_submit(
  p_student_no text, p_record_date date, p_request_id uuid,
  p_token_hash text, p_new_token_hash text,
  p_object_path text, p_mime text, p_bytes integer, p_self_minutes integer, p_note text
) returns jsonb language sql security definer set search_path = '' as $$
  select public.public_submit_images(
    p_student_no, p_record_date, p_request_id, p_token_hash, p_new_token_hash,
    case when p_object_path is null then null
         else jsonb_build_array(jsonb_build_object('path', p_object_path, 'mime', p_mime, 'bytes', p_bytes)) end,
    p_self_minutes, p_note)
$$;

-- ---------------------------------------------------------------------------
-- 정리 대상(고아 객체): 현재 버전 사진 세트에 연결된 객체는 지우지 않는다
-- ---------------------------------------------------------------------------

create or replace function public.term_object_names(p_term_id uuid, p_only_orphans boolean)
returns setof text language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'screenshots'
    and split_part(o.name, '/', 2) = p_term_id::text
    and (
      not p_only_orphans
      or (
        o.created_at < now() - interval '30 minutes'
        and not exists (select 1 from public.submissions s where s.image_path = o.name)
        and not exists (
          select 1 from public.submission_images i
          join public.submissions s on s.id = i.submission_id and s.image_version = i.image_version
          where i.storage_path = o.name)
      )
    )
  order by o.name
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한
-- ---------------------------------------------------------------------------

revoke all on function public.public_submit_images(text, date, uuid, text, text, jsonb, integer, text) from public, anon, authenticated;
grant execute on function public.public_submit_images(text, date, uuid, text, text, jsonb, integer, text) to service_role;
revoke all on function public.public_submit(text, date, uuid, text, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.public_submit(text, date, uuid, text, text, text, text, integer, integer, text) to service_role;
revoke all on function public.term_object_names(uuid, boolean) from public, anon, authenticated;
grant execute on function public.term_object_names(uuid, boolean) to service_role;
