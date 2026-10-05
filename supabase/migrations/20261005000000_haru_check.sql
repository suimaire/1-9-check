-- 하루체크: 시험기간 학급 스크린타임 인증
-- 원칙
--  * 노출 테이블은 anon/authenticated 권한을 모두 회수한 뒤 필요한 것만 다시 부여한다.
--  * 모든 노출 테이블에 RLS를 켠다. 역할·담당 관계는 서버가 관리하는 테이블(profiles, class_teachers)로만 판단한다.
--  * 제출 확정·지각 판정·접수 시각은 서버 함수가 서버 시각으로 결정한다.
--  * 날짜 판정은 Asia/Seoul 기준이다.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  app_title text not null default '1-9 체크' check (char_length(app_title) between 1 and 30),
  app_subtitle text not null default '시험기간 우리 반 루틴' check (char_length(app_subtitle) <= 40),
  created_at timestamptz not null default now()
);

-- 역할은 서버만 쓴다. user_metadata는 권한 근거로 쓰지 않는다.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  display_name text not null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.class_teachers (
  class_id uuid not null references public.classes (id) on delete cascade,
  teacher_id uuid not null references public.profiles (user_id) on delete cascade,
  primary key (class_id, teacher_id)
);

-- 학생 명단. 비활성화해도 삭제하지 않고 roster_until로 대상 범위를 닫는다.
create table public.students (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  student_no text not null check (student_no ~ '^[0-9A-Za-z-]{1,20}$'),
  name text not null check (char_length(name) between 1 and 30),
  login_id text unique,
  user_id uuid unique references auth.users (id) on delete set null,
  active boolean not null default true,
  roster_from date,
  roster_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, student_no),
  check (roster_from is null or roster_until is null or roster_until >= roster_from)
);

-- 발급 ID → 인증용 내부 이메일 별칭. 클라이언트 권한 없음(서버 함수만 조회).
create table public.login_aliases (
  login_id text primary key check (login_id = lower(login_id)),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  auth_email text not null unique,
  created_at timestamptz not null default now()
);

create table public.login_attempts (
  id bigint generated always as identity primary key,
  key text not null,
  attempted_at timestamptz not null default now()
);
create index login_attempts_key_time on public.login_attempts (key, attempted_at);

-- 운영 기간
create table public.terms (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  start_date date not null,
  last_record_date date not null,
  -- 기록일 D의 마감 = D+1 00:00 KST + deadline_minutes
  deadline_minutes integer not null default 480 check (deadline_minutes between 1 and 1439),
  -- 늦은 제출·재제출이 허용되는 마지막 시각
  final_close_at timestamptz not null,
  retention_until date,
  instructions text not null default '' check (char_length(instructions) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_record_date >= start_date),
  check (last_record_date - start_date <= 120)
);

-- 기록 대상일. 마감 시각은 날짜별로 서버에 고정 저장한다.
create table public.term_days (
  term_id uuid not null references public.terms (id) on delete cascade,
  record_date date not null,
  is_target boolean not null default true,
  window_open_at timestamptz not null,
  deadline_at timestamptz not null,
  note text check (char_length(note) <= 40),
  primary key (term_id, record_date),
  check (deadline_at > window_open_at)
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null,
  student_id uuid not null references public.students (id) on delete cascade,
  record_date date not null,
  image_path text not null,
  image_version integer not null default 1,
  image_mime text not null,
  image_bytes integer not null,
  first_submitted_at timestamptz not null,
  image_updated_at timestamptz not null,
  self_minutes integer check (self_minutes between 0 and 1440),
  student_note text check (char_length(student_note) <= 100),
  review_status text not null default 'unchecked'
    check (review_status in ('unchecked', 'checked', 'revision_requested')),
  reviewed_version integer,
  revision_message text check (char_length(revision_message) <= 200),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  unique (term_id, student_id, record_date),
  foreign key (term_id, record_date) references public.term_days (term_id, record_date)
);

-- 제출 확정 요청 기록(재시도 멱등성 + 최소 이력). 클라이언트 권한 없음.
create table public.submission_events (
  request_id uuid primary key,
  submission_id uuid not null references public.submissions (id) on delete cascade,
  student_id uuid not null,
  version integer not null,
  image_path text not null unique,
  created_at timestamptz not null default now()
);

create table public.excuse_requests (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null,
  student_id uuid not null references public.students (id) on delete cascade,
  record_date date not null,
  reason text not null check (reason in ('no_device', 'device_unavailable', 'no_record', 'other')),
  note text check (char_length(note) <= 100),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  unique (term_id, student_id, record_date),
  foreign key (term_id, record_date) references public.term_days (term_id, record_date)
);

create table public.exemptions (
  term_id uuid not null,
  student_id uuid not null references public.students (id) on delete cascade,
  record_date date not null,
  reason text check (char_length(reason) <= 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (term_id, student_id, record_date),
  foreign key (term_id, record_date) references public.term_days (term_id, record_date)
);

-- 교사 전용 지도 메모. 학생이 조회하는 테이블과 분리한다.
create table public.teacher_notes (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null references public.terms (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  record_date date,
  body text not null check (char_length(body) between 1 and 1000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index submissions_term_date on public.submissions (term_id, record_date);
create index excuse_term_date on public.excuse_requests (term_id, record_date);
create index exemptions_student on public.exemptions (student_id);
create index notes_student on public.teacher_notes (student_id);
create index students_class on public.students (class_id);

-- ---------------------------------------------------------------------------
-- 보조 함수 (app 스키마: API에 노출되지 않음)
-- ---------------------------------------------------------------------------

create or replace function app.kst_start_of(p_date date)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_date::timestamp at time zone 'Asia/Seoul')
$$;

-- 비밀번호 변경을 마친 활성 학생 본인의 students.id (아니면 null)
create or replace function app.current_student_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id
  from public.students s
  join public.profiles p on p.user_id = s.user_id
  where s.user_id = auth.uid()
    and s.active
    and p.role = 'student'
    and not p.must_change_password
$$;

create or replace function app.current_student_class_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.class_id from public.students s where s.id = app.current_student_id()
$$;

create or replace function app.is_class_teacher(p_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.class_teachers ct
    join public.profiles p on p.user_id = ct.teacher_id
    where ct.class_id = p_class_id
      and ct.teacher_id = auth.uid()
      and p.role = 'teacher'
      and not p.must_change_password
  )
$$;

create or replace function app.is_student_teacher(p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.students s
    where s.id = p_student_id and app.is_class_teacher(s.class_id)
  )
$$;

create or replace function app.can_view_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_class_teacher(p_class_id) or p_class_id = app.current_student_class_id()
$$;

create or replace function app.can_view_term(p_term_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.terms t where t.id = p_term_id and app.can_view_class(t.class_id))
$$;

-- 이미지 경로: {auth uid}/{term id}/{uuid}.{jpg|png|webp}
create or replace function app.can_upload_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
    and split_part(p_name, '/', 1) = auth.uid()::text
    and app.current_student_id() is not null
    and exists (
      select 1 from public.terms t
      where t.id::text = split_part(p_name, '/', 2)
        and t.class_id = app.current_student_class_id()
        and now() <= t.final_close_at
    )
$$;

create or replace function app.can_read_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.students s
    where s.user_id::text = split_part(p_name, '/', 1)
      and (
        (s.user_id = auth.uid() and s.id = app.current_student_id())
        or app.is_class_teacher(s.class_id)
      )
  )
$$;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;

-- 이미 제출 창이 열린 날짜의 마감 시각은 바꾸지 않는다(지각 판정 소급 방지).
create or replace function app.lock_opened_deadline()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.window_open_at <= now()
     and (new.deadline_at is distinct from old.deadline_at
          or new.window_open_at is distinct from old.window_open_at) then
    raise exception 'deadline_locked';
  end if;
  return new;
end
$$;

create trigger term_days_lock_deadline
before update on public.term_days
for each row execute function app.lock_opened_deadline();

-- ---------------------------------------------------------------------------
-- 권한: 전부 회수 후 최소 부여
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;

grant select on public.classes, public.profiles, public.class_teachers, public.students,
  public.terms, public.term_days, public.submissions, public.excuse_requests,
  public.exemptions, public.teacher_notes to authenticated;

grant update (app_title, app_subtitle) on public.classes to authenticated;
grant insert (class_id, student_no, name, roster_from, roster_until) on public.students to authenticated;
grant update (student_no, name, roster_from, roster_until) on public.students to authenticated;
grant insert (term_id, student_id, record_date, body), update (body, updated_at), delete
  on public.teacher_notes to authenticated;

alter table public.classes enable row level security;
alter table public.profiles enable row level security;
alter table public.class_teachers enable row level security;
alter table public.students enable row level security;
alter table public.login_aliases enable row level security;
alter table public.login_attempts enable row level security;
alter table public.terms enable row level security;
alter table public.term_days enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_events enable row level security;
alter table public.excuse_requests enable row level security;
alter table public.exemptions enable row level security;
alter table public.teacher_notes enable row level security;

create policy classes_select on public.classes for select to authenticated
  using (app.can_view_class(id));
create policy classes_update on public.classes for update to authenticated
  using (app.is_class_teacher(id)) with check (app.is_class_teacher(id));

create policy profiles_select on public.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.students s
               where s.user_id = profiles.user_id and app.is_class_teacher(s.class_id))
  );

create policy class_teachers_select on public.class_teachers for select to authenticated
  using (teacher_id = (select auth.uid()));

create policy students_select on public.students for select to authenticated
  using (id = app.current_student_id() or app.is_class_teacher(class_id));
create policy students_insert on public.students for insert to authenticated
  with check (app.is_class_teacher(class_id));
create policy students_update on public.students for update to authenticated
  using (app.is_class_teacher(class_id)) with check (app.is_class_teacher(class_id));

create policy terms_select on public.terms for select to authenticated
  using (app.can_view_class(class_id));
create policy term_days_select on public.term_days for select to authenticated
  using (app.can_view_term(term_id));

create policy submissions_select on public.submissions for select to authenticated
  using (student_id = app.current_student_id() or app.is_student_teacher(student_id));
create policy excuses_select on public.excuse_requests for select to authenticated
  using (student_id = app.current_student_id() or app.is_student_teacher(student_id));
create policy exemptions_select on public.exemptions for select to authenticated
  using (student_id = app.current_student_id() or app.is_student_teacher(student_id));

-- 교사 메모: 학생 정책 없음 → 학생은 행 자체를 읽을 수 없다.
create policy notes_teacher_all on public.teacher_notes for all to authenticated
  using (app.is_student_teacher(student_id))
  with check (
    app.is_student_teacher(student_id)
    and exists (select 1 from public.terms t join public.students s on s.class_id = t.class_id
                where t.id = term_id and s.id = student_id)
  );

-- login_aliases, login_attempts, submission_events: 클라이언트 정책 없음(서버 키 전용)

-- ---------------------------------------------------------------------------
-- 클라이언트 호출 함수 (authenticated)
-- ---------------------------------------------------------------------------

create or replace function public.server_time()
returns timestamptz language sql stable set search_path = '' as $$ select now() $$;

-- 제출 가능 여부 공통 검사(학생·날짜). 실패 시 예외 코드 문자열을 던진다.
create or replace function app.assert_submittable(p_student_id uuid, p_term_id uuid, p_record_date date)
returns public.term_days language plpgsql stable security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
  v_term public.terms%rowtype;
  v_day public.term_days%rowtype;
begin
  select * into v_student from public.students where id = p_student_id and active;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_term from public.terms where id = p_term_id and class_id = v_student.class_id;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_day from public.term_days where term_id = p_term_id and record_date = p_record_date;
  if not found then raise exception 'date_out_of_range'; end if;
  if not v_day.is_target then raise exception 'not_target_day'; end if;
  if (v_student.roster_from is not null and p_record_date < v_student.roster_from)
     or (v_student.roster_until is not null and p_record_date > v_student.roster_until) then
    raise exception 'not_on_roster';
  end if;
  -- 미래 날짜·아직 끝나지 않은 당일은 거절
  if now() < v_day.window_open_at then raise exception 'window_not_open'; end if;
  if now() > v_term.final_close_at then raise exception 'window_closed'; end if;
  return v_day;
end
$$;
revoke all on function app.assert_submittable(uuid, uuid, date) from public, anon, authenticated;
grant execute on function app.assert_submittable(uuid, uuid, date) to service_role;

create or replace function public.submit_excuse(
  p_term_id uuid, p_record_date date, p_reason text, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_student_id uuid := app.current_student_id();
  v_row public.excuse_requests%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_student_id is null then raise exception 'not_allowed'; end if;
  if p_reason not in ('no_device', 'device_unavailable', 'no_record', 'other') then
    raise exception 'bad_request';
  end if;
  if char_length(v_note) > 100 then raise exception 'note_too_long'; end if;
  perform app.assert_submittable(v_student_id, p_term_id, p_record_date);

  insert into public.excuse_requests (term_id, student_id, record_date, reason, note)
  values (p_term_id, v_student_id, p_record_date, p_reason, v_note)
  on conflict (term_id, student_id, record_date) do update
    set reason = excluded.reason,
        note = excluded.note,
        status = case when public.excuse_requests.status = 'approved' then 'approved' else 'pending' end,
        updated_at = now()
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end
$$;

create or replace function public.review_submission(
  p_submission_id uuid, p_version integer, p_status text, p_message text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.submissions%rowtype;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
begin
  select * into v_sub from public.submissions where id = p_submission_id for update;
  if not found or not app.is_student_teacher(v_sub.student_id) then
    raise exception 'not_allowed';
  end if;
  if p_status not in ('unchecked', 'checked', 'revision_requested') then
    raise exception 'bad_request';
  end if;
  -- 교사가 보고 있던 이미지 버전에만 적용한다.
  if v_sub.image_version <> p_version then raise exception 'stale_version'; end if;
  if p_status = 'revision_requested' and v_msg is null then raise exception 'message_required'; end if;
  if char_length(v_msg) > 200 then raise exception 'message_too_long'; end if;

  update public.submissions
  set review_status = p_status,
      reviewed_version = case when p_status = 'unchecked' then null else p_version end,
      revision_message = case when p_status = 'revision_requested' then v_msg else revision_message end,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_submission_id
  returning * into v_sub;
  return jsonb_build_object('id', v_sub.id, 'review_status', v_sub.review_status, 'version', v_sub.image_version);
end
$$;

create or replace function public.resolve_excuse(p_excuse_id uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ex public.excuse_requests%rowtype;
begin
  select * into v_ex from public.excuse_requests where id = p_excuse_id for update;
  if not found or not app.is_student_teacher(v_ex.student_id) then raise exception 'not_allowed'; end if;
  update public.excuse_requests
  set status = case when p_approve then 'approved' else 'declined' end,
      resolved_at = now(), resolved_by = auth.uid()
  where id = p_excuse_id;
  if p_approve then
    insert into public.exemptions (term_id, student_id, record_date, reason, created_by)
    values (v_ex.term_id, v_ex.student_id, v_ex.record_date, '사유 승인', auth.uid())
    on conflict (term_id, student_id, record_date) do nothing;
  end if;
  return jsonb_build_object('id', p_excuse_id, 'approved', p_approve);
end
$$;

-- 기간 면제 지정(p_exempt=true) 또는 취소(false). 제출 기록은 지우지 않는다.
create or replace function public.set_exemptions(
  p_term_id uuid, p_student_id uuid, p_from date, p_to date, p_exempt boolean, p_reason text
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not app.is_student_teacher(p_student_id) or not exists (
    select 1 from public.terms t join public.students s on s.class_id = t.class_id
    where t.id = p_term_id and s.id = p_student_id
  ) then
    raise exception 'not_allowed';
  end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'bad_request'; end if;

  if p_exempt then
    insert into public.exemptions (term_id, student_id, record_date, reason, created_by)
    select p_term_id, p_student_id, d.record_date, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()
    from public.term_days d
    where d.term_id = p_term_id and d.record_date between p_from and p_to
    on conflict (term_id, student_id, record_date) do update set reason = excluded.reason;
  else
    delete from public.exemptions
    where term_id = p_term_id and student_id = p_student_id and record_date between p_from and p_to;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- 운영 기간 생성/수정 및 날짜 생성. 이미 제출 창이 열린 날짜의 마감은 유지한다.
create or replace function public.save_term(
  p_class_id uuid, p_term_id uuid, p_name text, p_start date, p_last date,
  p_deadline_minutes integer, p_final_close_at timestamptz, p_retention_until date, p_instructions text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_term_id;
  v_last_deadline timestamptz;
  v_final timestamptz;
  d date;
begin
  if not app.is_class_teacher(p_class_id) then raise exception 'not_allowed'; end if;
  if p_start is null or p_last is null or p_last < p_start or p_last - p_start > 120 then
    raise exception 'bad_range';
  end if;
  if p_deadline_minutes is null or p_deadline_minutes not between 1 and 1439 then
    raise exception 'bad_deadline';
  end if;

  v_last_deadline := app.kst_start_of(p_last + 1) + make_interval(mins => p_deadline_minutes);
  v_final := coalesce(p_final_close_at, v_last_deadline + interval '7 days');
  if v_final < v_last_deadline then raise exception 'final_before_deadline'; end if;

  if v_id is null then
    insert into public.terms (class_id, name, start_date, last_record_date, deadline_minutes,
                              final_close_at, retention_until, instructions)
    values (p_class_id, btrim(p_name), p_start, p_last, p_deadline_minutes, v_final,
            coalesce(p_retention_until, (v_final at time zone 'Asia/Seoul')::date + 30),
            coalesce(p_instructions, ''))
    returning id into v_id;
  else
    if not exists (select 1 from public.terms where id = v_id and class_id = p_class_id) then
      raise exception 'not_allowed';
    end if;
    if exists (
      select 1 from public.term_days td
      where td.term_id = v_id and (td.record_date < p_start or td.record_date > p_last)
        and (exists (select 1 from public.submissions s where s.term_id = v_id and s.record_date = td.record_date)
          or exists (select 1 from public.excuse_requests e where e.term_id = v_id and e.record_date = td.record_date)
          or exists (select 1 from public.exemptions x where x.term_id = v_id and x.record_date = td.record_date))
    ) then
      raise exception 'range_has_data';
    end if;
    update public.terms
    set name = btrim(p_name), start_date = p_start, last_record_date = p_last,
        deadline_minutes = p_deadline_minutes, final_close_at = v_final,
        retention_until = p_retention_until, instructions = coalesce(p_instructions, ''),
        updated_at = now()
    where id = v_id;
    delete from public.term_days
    where term_id = v_id and (record_date < p_start or record_date > p_last);
  end if;

  for d in select generate_series(p_start, p_last, interval '1 day')::date loop
    insert into public.term_days (term_id, record_date, window_open_at, deadline_at)
    values (v_id, d, app.kst_start_of(d + 1),
            app.kst_start_of(d + 1) + make_interval(mins => p_deadline_minutes))
    on conflict (term_id, record_date) do update
      set deadline_at = excluded.deadline_at
      where public.term_days.window_open_at > now()
        and public.term_days.deadline_at is distinct from excluded.deadline_at;
  end loop;
  return v_id;
end
$$;

create or replace function public.set_day_target(
  p_term_id uuid, p_record_date date, p_is_target boolean, p_note text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.terms t where t.id = p_term_id and app.is_class_teacher(t.class_id)) then
    raise exception 'not_allowed';
  end if;
  update public.term_days
  set is_target = p_is_target, note = nullif(btrim(coalesce(p_note, '')), '')
  where term_id = p_term_id and record_date = p_record_date;
  if not found then raise exception 'date_out_of_range'; end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 서버 키 전용 함수 (Edge Function에서만 호출)
-- ---------------------------------------------------------------------------

-- 제출 확정. p_user_id는 Edge Function이 검증한 JWT의 사용자다(클라이언트 값 아님).
create or replace function public.confirm_submission(
  p_user_id uuid, p_term_id uuid, p_record_date date, p_object_path text,
  p_request_id uuid, p_expected_version integer, p_self_minutes integer, p_note text,
  p_mime text, p_bytes integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
  v_day public.term_days%rowtype;
  v_sub public.submissions%rowtype;
  v_event public.submission_events%rowtype;
  v_obj_owner text;
  v_obj_size bigint;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_now timestamptz := now();
begin
  if p_user_id is null or p_request_id is null or p_object_path is null then
    raise exception 'bad_request';
  end if;

  select s.* into v_student
  from public.students s join public.profiles p on p.user_id = s.user_id
  where s.user_id = p_user_id and p.role = 'student' and not p.must_change_password;
  if not found then raise exception 'not_allowed'; end if;

  -- 같은 요청의 재시도: 상태를 바꾸지 않고 처음 결과를 돌려준다.
  select * into v_event from public.submission_events where request_id = p_request_id;
  if found then
    if v_event.student_id <> v_student.id then raise exception 'bad_request'; end if;
    select * into v_sub from public.submissions where id = v_event.submission_id;
    select * into v_day from public.term_days where term_id = v_sub.term_id and record_date = v_sub.record_date;
    return jsonb_build_object(
      'replayed', true, 'submission_id', v_sub.id, 'version', v_event.version,
      'current_version', v_sub.image_version, 'first_submitted_at', v_sub.first_submitted_at,
      'late', v_sub.first_submitted_at > v_day.deadline_at);
  end if;

  v_day := app.assert_submittable(v_student.id, p_term_id, p_record_date);

  if p_self_minutes is not null and p_self_minutes not between 0 and 1440 then
    raise exception 'bad_minutes';
  end if;
  if char_length(v_note) > 100 then raise exception 'note_too_long'; end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'bad_type'; end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > 2097152 then raise exception 'too_large'; end if;

  -- 객체 경로·실존·소유권(학생 JWT로 올린 객체만 owner_id가 학생 uid)
  if split_part(p_object_path, '/', 1) <> p_user_id::text
     or split_part(p_object_path, '/', 2) <> p_term_id::text
     or p_object_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' then
    raise exception 'bad_path';
  end if;
  select o.owner_id, (o.metadata ->> 'size')::bigint into v_obj_owner, v_obj_size
  from storage.objects o
  where o.bucket_id = 'screenshots' and o.name = p_object_path;
  if not found then raise exception 'object_missing'; end if;
  if v_obj_owner is distinct from p_user_id::text then raise exception 'object_not_owned'; end if;
  if v_obj_size is not null and v_obj_size > 2097152 then raise exception 'too_large'; end if;
  if exists (select 1 from public.submission_events where image_path = p_object_path) then
    raise exception 'path_reused';
  end if;

  select * into v_sub from public.submissions
  where term_id = p_term_id and student_id = v_student.id and record_date = p_record_date
  for update;

  if not found then
    if coalesce(p_expected_version, 0) <> 0 then raise exception 'version_conflict'; end if;
    begin
      insert into public.submissions (
        term_id, student_id, record_date, image_path, image_version, image_mime, image_bytes,
        first_submitted_at, image_updated_at, self_minutes, student_note)
      values (p_term_id, v_student.id, p_record_date, p_object_path, 1, p_mime, p_bytes,
              v_now, v_now, p_self_minutes, v_note)
      returning * into v_sub;
    exception when unique_violation then
      raise exception 'version_conflict';
    end;
  else
    -- 오래된 재시도가 최신 이미지를 덮지 않도록 버전을 비교한다.
    if coalesce(p_expected_version, 0) <> v_sub.image_version then
      raise exception 'version_conflict';
    end if;
    -- 최초 접수 시각·정시/지각 판정은 보존하고, 확인 상태만 미확인으로 되돌린다.
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
        reviewed_by = null
    where id = v_sub.id
    returning * into v_sub;
  end if;

  insert into public.submission_events (request_id, submission_id, student_id, version, image_path)
  values (p_request_id, v_sub.id, v_student.id, v_sub.image_version, p_object_path);

  return jsonb_build_object(
    'replayed', false, 'submission_id', v_sub.id, 'version', v_sub.image_version,
    'current_version', v_sub.image_version, 'first_submitted_at', v_sub.first_submitted_at,
    'late', v_sub.first_submitted_at > v_day.deadline_at);
end
$$;

-- 로그인 식별자 조회 시도 제한. 허용이면 true. 시도는 항상 기록한다.
create or replace function public.login_rate_check(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from public.login_attempts where attempted_at < now() - interval '1 day';
  select count(*) into v_count from public.login_attempts
  where key = p_key and attempted_at > now() - make_interval(secs => p_window_seconds);
  insert into public.login_attempts (key) values (p_key);
  return v_count < p_max;
end
$$;

-- 운영 기간의 Storage 객체 이름(only_orphans=true면 현재 제출에 연결되지 않은 30분 지난 객체만)
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
      )
    )
  order by o.name
$$;

create or replace function public.purge_preview(p_term_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'term_id', t.id, 'name', t.name, 'start_date', t.start_date, 'last_record_date', t.last_record_date,
    'submissions', (select count(*) from public.submissions where term_id = t.id),
    'submission_events', (select count(*) from public.submission_events e
                          join public.submissions s on s.id = e.submission_id where s.term_id = t.id),
    'excuse_requests', (select count(*) from public.excuse_requests where term_id = t.id),
    'exemptions', (select count(*) from public.exemptions where term_id = t.id),
    'teacher_notes', (select count(*) from public.teacher_notes where term_id = t.id),
    'term_days', (select count(*) from public.term_days where term_id = t.id),
    'objects', (select count(*) from storage.objects o
                where o.bucket_id = 'screenshots' and split_part(o.name, '/', 2) = t.id::text)
  )
  from public.terms t where t.id = p_term_id
$$;

-- Storage 객체를 Storage API로 모두 지운 뒤에만 DB 행을 지운다.
create or replace function public.purge_term_rows(p_term_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_preview jsonb := public.purge_preview(p_term_id);
begin
  if v_preview is null then raise exception 'not_found'; end if;
  if (v_preview ->> 'objects')::int > 0 then raise exception 'objects_remaining'; end if;
  delete from public.teacher_notes where term_id = p_term_id;
  delete from public.exemptions where term_id = p_term_id;
  delete from public.excuse_requests where term_id = p_term_id;
  delete from public.submissions where term_id = p_term_id;
  delete from public.term_days where term_id = p_term_id;
  delete from public.terms where id = p_term_id;
  return v_preview;
end
$$;

-- 함수 실행 권한: 기본(PUBLIC) 회수 후 명시 부여
revoke all on function public.server_time() from public, anon;
revoke all on function public.submit_excuse(uuid, date, text, text) from public, anon;
revoke all on function public.review_submission(uuid, integer, text, text) from public, anon;
revoke all on function public.resolve_excuse(uuid, boolean) from public, anon;
revoke all on function public.set_exemptions(uuid, uuid, date, date, boolean, text) from public, anon;
revoke all on function public.save_term(uuid, uuid, text, date, date, integer, timestamptz, date, text) from public, anon;
revoke all on function public.set_day_target(uuid, date, boolean, text) from public, anon;
grant execute on function public.server_time() to authenticated;
grant execute on function public.submit_excuse(uuid, date, text, text) to authenticated;
grant execute on function public.review_submission(uuid, integer, text, text) to authenticated;
grant execute on function public.resolve_excuse(uuid, boolean) to authenticated;
grant execute on function public.set_exemptions(uuid, uuid, date, date, boolean, text) to authenticated;
grant execute on function public.save_term(uuid, uuid, text, date, date, integer, timestamptz, date, text) to authenticated;
grant execute on function public.set_day_target(uuid, date, boolean, text) to authenticated;

revoke all on function public.confirm_submission(uuid, uuid, date, text, uuid, integer, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.login_rate_check(text, integer, integer) from public, anon, authenticated;
revoke all on function public.term_object_names(uuid, boolean) from public, anon, authenticated;
revoke all on function public.purge_preview(uuid) from public, anon, authenticated;
revoke all on function public.purge_term_rows(uuid) from public, anon, authenticated;
grant execute on function public.confirm_submission(uuid, uuid, date, text, uuid, integer, integer, text, text, integer) to service_role;
grant execute on function public.login_rate_check(text, integer, integer) to service_role;
grant execute on function public.term_object_names(uuid, boolean) to service_role;
grant execute on function public.purge_preview(uuid) to service_role;
grant execute on function public.purge_term_rows(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Storage: 비공개 버킷 + 객체 정책
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 학생: 새 경로에 INSERT만 허용. UPDATE/DELETE 정책은 만들지 않는다(덮어쓰기·삭제 불가).
create policy screenshots_student_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'screenshots' and app.can_upload_object(name));

-- 조회: 본인 이미지 또는 담당 교사.
create policy screenshots_read on storage.objects for select to authenticated
  using (bucket_id = 'screenshots' and app.can_read_object(name));
