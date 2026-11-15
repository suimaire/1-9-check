-- Independent opt-in weekend program. Existing terms, days and submission history are unchanged.
-- Created directly after cached `supabase migration new` failed on a denied telemetry write.
alter table public.terms add column submission_mode text not null default 'daily'
  check (submission_mode in ('daily', 'weekend'));
alter table public.classes add column public_term_id uuid references public.terms(id) on delete set null;

create table public.term_participants (
  term_id uuid not null references public.terms(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (term_id, student_id)
);
alter table public.term_participants enable row level security;
create policy term_participants_teacher_select on public.term_participants for select to authenticated
using (exists (select 1 from public.terms t where t.id = term_id and app.is_class_teacher(t.class_id)));
revoke all on public.term_participants from public, anon, authenticated;
grant select on public.term_participants to authenticated;
grant all on public.term_participants to service_role;

create or replace function public.save_weekend_term(
  p_class_id uuid, p_term_id uuid, p_name text, p_deadline_minutes integer, p_instructions text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_term_id;
  d date;
begin
  if not app.is_class_teacher(p_class_id) then raise exception 'not_allowed'; end if;
  if p_deadline_minutes is null or p_deadline_minutes not between 1 and 1439 then
    raise exception 'bad_deadline';
  end if;
  if v_id is null then
    insert into public.terms (class_id,name,start_date,last_record_date,deadline_minutes,
                             final_close_at,retention_until,instructions,submission_mode)
    values (p_class_id,btrim(p_name),'2026-11-21','2026-12-06',p_deadline_minutes,
            '2026-12-07T23:59:59.999+09:00','2027-01-06',coalesce(p_instructions,''),'weekend')
    returning id into v_id;
  else
    perform 1 from public.terms where id = v_id and class_id = p_class_id and submission_mode = 'weekend' for update;
    if not found then raise exception 'not_allowed'; end if;
    update public.terms set name=btrim(p_name),deadline_minutes=p_deadline_minutes,
      instructions=coalesce(p_instructions,''),updated_at=now() where id=v_id;
  end if;
  foreach d in array array['2026-11-21','2026-11-22','2026-11-28','2026-11-29','2026-12-05','2026-12-06']::date[] loop
    insert into public.term_days(term_id,record_date,window_open_at,deadline_at)
    values(v_id,d,app.kst_start_of(d + case when extract(isodow from d)=6 then 2 else 1 end),app.kst_start_of(d + case when extract(isodow from d)=6 then 2 else 1 end)+make_interval(mins=>p_deadline_minutes))
    on conflict(term_id,record_date) do update set deadline_at=excluded.deadline_at
    where public.term_days.window_open_at > now()
      and public.term_days.deadline_at is distinct from excluded.deadline_at;
  end loop;
  return v_id;
end
$$;

create or replace function public.set_public_term(p_class_id uuid,p_term_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_class_teacher(p_class_id) then raise exception 'not_allowed'; end if;
  -- Public submissions take a SHARE lock on this same row, so a pin cannot change mid-transaction.
  perform 1 from public.classes where id=p_class_id for update;
  if p_term_id is not null and not exists (select 1 from public.terms where id=p_term_id and class_id=p_class_id) then
    raise exception 'not_allowed';
  end if;
  update public.classes set public_term_id=p_term_id where id=p_class_id;
end
$$;

create or replace function public.set_term_participants(p_term_id uuid,p_student_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_class_id uuid;
begin
  -- The term lock also covers absent participant rows and serializes simultaneous list replacements.
  select class_id into v_class_id from public.terms
  where id=p_term_id and submission_mode='weekend' and app.is_class_teacher(class_id) for update;
  if not found then raise exception 'not_allowed'; end if;
  if p_student_ids is null then raise exception 'bad_request'; end if;
  perform 1 from public.students where id=any(p_student_ids) for share;
  if exists (select 1 from unnest(p_student_ids) x(id)
             where id is null or not exists(select 1 from public.students s where s.id=x.id and s.class_id=v_class_id and s.active)) then
    raise exception 'not_allowed';
  end if;
  update public.term_participants set active=false,updated_at=now()
    where term_id=p_term_id and active and not(student_id=any(p_student_ids));
  insert into public.term_participants(term_id,student_id,active)
    select p_term_id,id,true from (select distinct unnest(p_student_ids) id) ids
  on conflict(term_id,student_id) do update set active=true,updated_at=now();
end
$$;

-- Separate membership check permits receipt recovery after final close, but never after exclusion.
create or replace function app.assert_term_participant(p_student_id uuid,p_term_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_term public.terms%rowtype;
begin
  select * into v_term from public.terms where id=p_term_id for share;
  if not found then raise exception 'not_allowed'; end if;
  if v_term.submission_mode='weekend' then
    perform 1 from public.term_participants where term_id=p_term_id and student_id=p_student_id and active for share;
    if not found then raise exception 'not_participant'; end if;
  end if;
end
$$;

-- Weekend dates are fixed even when an older teacher client calls the generic day API.
create or replace function app.guard_weekend_day()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.terms where id=new.term_id and submission_mode='weekend') then
    if new.record_date <> all(array['2026-11-21','2026-11-22','2026-11-28','2026-11-29','2026-12-05','2026-12-06']::date[])
       or not new.is_target or new.window_open_at <> app.kst_start_of(new.record_date + case when extract(isodow from new.record_date)=6 then 2 else 1 end) then
      raise exception 'weekend_dates_fixed';
    end if;
  end if;
  return new;
end
$$;
create trigger term_days_weekend_guard before insert or update on public.term_days
for each row execute function app.guard_weekend_day();

revoke all on function public.save_weekend_term(uuid,uuid,text,integer,text) from public,anon;
revoke all on function public.set_public_term(uuid,uuid) from public,anon;
revoke all on function public.set_term_participants(uuid,uuid[]) from public,anon;
grant execute on function public.save_weekend_term(uuid,uuid,text,integer,text) to authenticated;
grant execute on function public.set_public_term(uuid,uuid) to authenticated;
grant execute on function public.set_term_participants(uuid,uuid[]) to authenticated;
revoke all on function app.assert_term_participant(uuid,uuid) from public,anon,authenticated;
revoke all on function app.guard_weekend_day() from public,anon,authenticated;
grant execute on function app.assert_term_participant(uuid,uuid) to service_role;

create or replace function app.public_student(p_student_no text)
returns public.students language plpgsql security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
begin
  if p_student_no is null or p_student_no !~ '^109(0[1-9]|[12][0-9]|3[0-4])$' then
    raise exception 'invalid_student_no';
  end if;
  select s.* into v_student
  from public.students s join public.classes c on c.id = s.class_id
  where c.public_submit and s.student_no = p_student_no and s.active for share of c, s;
  if not found then raise exception 'invalid_student_no'; end if;
  return v_student;
end
$$;

create or replace function app.assert_submittable(p_student_id uuid, p_term_id uuid, p_record_date date)
returns public.term_days language plpgsql security definer set search_path = '' as $$
declare
  v_student public.students%rowtype;
  v_term public.terms%rowtype;
  v_day public.term_days%rowtype;
begin
  perform app.assert_term_participant(p_student_id,p_term_id);
  select * into v_student from public.students where id = p_student_id and active for share;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_term from public.terms where id = p_term_id and class_id = v_student.class_id;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_day from public.term_days where term_id = p_term_id and record_date = p_record_date for share;
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
  if exists(select 1 from public.terms where id=p_term_id and submission_mode='weekend') then
    raise exception 'wrong_submission_mode';
  end if;
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
    if v_sub.record_date is distinct from p_record_date then raise exception 'bad_request'; end if;
    perform app.assert_term_participant(v_student.id,v_sub.term_id);
    if v_sub.token_request_id = p_request_id then
      update public.submissions set replacement_token_hash = p_new_token_hash
      where id = v_sub.id returning * into v_sub;
      return app.public_result(v_sub, true, v_event.version > 1, true);
    end if;
    return app.public_result(v_sub, true, v_event.version > 1, false);
  end if;

  select d.* into v_day
  from public.term_days d join public.terms t on t.id = d.term_id
  join public.classes c on c.id=t.class_id
  where t.class_id = v_student.class_id and d.record_date = p_record_date
    and ((c.public_term_id is null and t.submission_mode='daily') or t.id=c.public_term_id)
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

-- Bind the displayed term to both preflight and finalization, while preserving the legacy API.
create function public.public_submit_images_for_term(
  p_expected_term_id uuid, p_student_no text, p_record_date date, p_request_id uuid,
  p_token_hash text, p_new_token_hash text, p_images jsonb, p_self_minutes integer, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_student public.students%rowtype; v_term_id uuid;
begin
  if p_expected_term_id is null then raise exception 'bad_request'; end if;
  v_student := app.public_student(p_student_no);
  select s.term_id into v_term_id from public.submission_events e
    join public.submissions s on s.id=e.submission_id where e.request_id=p_request_id;
  if not found then
    select t.id into v_term_id from public.terms t
      join public.classes c on c.id=t.class_id
      join public.term_days d on d.term_id=t.id
      where t.class_id=v_student.class_id and d.record_date=p_record_date
        and ((c.public_term_id is null and t.submission_mode='daily') or t.id=c.public_term_id)
      order by t.start_date desc limit 1;
  end if;
  if v_term_id is distinct from p_expected_term_id then raise exception 'term_changed'; end if;
  return public.public_submit_images(p_student_no,p_record_date,p_request_id,p_token_hash,p_new_token_hash,p_images,p_self_minutes,p_note);
end
$$;
revoke all on function public.public_submit_images_for_term(uuid,text,date,uuid,text,text,jsonb,integer,text) from public,anon,authenticated;
grant execute on function public.public_submit_images_for_term(uuid,text,date,uuid,text,text,jsonb,integer,text) to service_role;

-- An unguessable request ID recovers only its own receipt; no lookup by student number alone.
create function public.public_recover_submission(
  p_expected_term_id uuid,p_student_no text,p_record_date date,p_request_id uuid,p_new_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.submission_events where request_id=p_request_id) then return null; end if;
  return public.public_submit_images_for_term(p_expected_term_id,p_student_no,p_record_date,p_request_id,null,p_new_token_hash,null,null,null);
end
$$;
revoke all on function public.public_recover_submission(uuid,text,date,uuid,text) from public,anon,authenticated;
grant execute on function public.public_recover_submission(uuid,text,date,uuid,text) to service_role;

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
  where class_id = v_class.id
    and (case when v_class.public_term_id is not null then id=v_class.public_term_id else submission_mode='daily' and final_close_at >= v_now end)
  order by start_date
  limit 1;
  return jsonb_build_object(
    'server_now', v_now,
    'ready', true,
    'app_title', v_class.app_title,
    'app_subtitle', v_class.app_subtitle,
    'term', case when v_term.id is null then null else jsonb_build_object(
      'id', v_term.id, 'submission_mode', v_term.submission_mode,
      'name', v_term.name, 'instructions', v_term.instructions, 'final_close_at', v_term.final_close_at) end,
    -- 지금 제출할 수 있는 대상일(최근 7일, 최신순)
    'open_days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'record_date', d.record_date, 'window_open_at', d.window_open_at, 'deadline_at', d.deadline_at)
        order by d.record_date desc)
      from (select * from public.term_days
            where term_id = v_term.id and is_target
              and window_open_at <= v_now
              and (v_term.submission_mode='daily' or v_now <= v_term.final_close_at)
            order by record_date desc limit case when v_term.submission_mode='weekend' then 6 else 7 end) d), '[]'::jsonb),
    'next_day', (
      select jsonb_build_object(
        'record_date', d.record_date, 'window_open_at', d.window_open_at, 'deadline_at', d.deadline_at)
      from public.term_days d
      where d.term_id = v_term.id and d.is_target and d.window_open_at > v_now
        and (v_term.submission_mode='daily' or v_now <= v_term.final_close_at)
      order by d.record_date
      limit 1));
end
$$;
