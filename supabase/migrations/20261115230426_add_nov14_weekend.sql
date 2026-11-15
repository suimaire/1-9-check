-- Include the November 14/15 weekend without changing existing deadlines or submissions.
create or replace function app.guard_weekend_day()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.terms where id=new.term_id and submission_mode='weekend') then
    if new.record_date <> all(array['2026-11-14','2026-11-15','2026-11-21','2026-11-22','2026-11-28','2026-11-29','2026-12-05','2026-12-06']::date[])
       or not new.is_target or new.window_open_at <> app.kst_start_of(new.record_date + case when extract(isodow from new.record_date)=6 then 2 else 1 end) then
      raise exception 'weekend_dates_fixed';
    end if;
  end if;
  return new;
end
$$;

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
    values (p_class_id,btrim(p_name),'2026-11-14','2026-12-06',p_deadline_minutes,
            '2026-12-07T23:59:59.999+09:00','2027-01-06',coalesce(p_instructions,''),'weekend')
    returning id into v_id;
  else
    perform 1 from public.terms where id = v_id and class_id = p_class_id and submission_mode = 'weekend' for update;
    if not found then raise exception 'not_allowed'; end if;
    update public.terms set start_date='2026-11-14',name=btrim(p_name),deadline_minutes=p_deadline_minutes,
      instructions=coalesce(p_instructions,''),updated_at=now() where id=v_id;
  end if;
  foreach d in array array['2026-11-14','2026-11-15','2026-11-21','2026-11-22','2026-11-28','2026-11-29','2026-12-05','2026-12-06']::date[] loop
    insert into public.term_days(term_id,record_date,window_open_at,deadline_at)
    values(v_id,d,app.kst_start_of(d + case when extract(isodow from d)=6 then 2 else 1 end),app.kst_start_of(d + case when extract(isodow from d)=6 then 2 else 1 end)+make_interval(mins=>p_deadline_minutes))
    on conflict(term_id,record_date) do update set deadline_at=excluded.deadline_at
    where public.term_days.window_open_at > now()
      and public.term_days.deadline_at is distinct from excluded.deadline_at;
  end loop;
  return v_id;
end
$$;


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
            order by record_date desc limit case when v_term.submission_mode='weekend' then 8 else 7 end) d), '[]'::jsonb),
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

-- Add only the missing pair to the published final-exam program. Existing day rows are never updated.
do $$
declare v_term public.terms%rowtype; d date;
begin
  for v_term in select t.* from public.terms t join public.classes c on c.public_term_id=t.id
    where c.public_submit and t.submission_mode='weekend'
      and t.start_date in ('2026-11-14','2026-11-21') and t.last_record_date='2026-12-06'
    for update of t loop
    update public.terms set start_date='2026-11-14',updated_at=now() where id=v_term.id and start_date<>'2026-11-14';
    foreach d in array array['2026-11-14','2026-11-15']::date[] loop
      insert into public.term_days(term_id,record_date,window_open_at,deadline_at)
      values(v_term.id,d,'2026-11-16T00:00:00+09:00',
             '2026-11-16T00:00:00+09:00'::timestamptz+make_interval(mins=>v_term.deadline_minutes))
      on conflict(term_id,record_date) do nothing;
    end loop;
  end loop;
end
$$;
