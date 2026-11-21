-- Keyturn: what a decision rests on.
--
-- A proposal shows the rows it would change. Whether the change is right is often decided by
-- other rows: the payment a refund is for, the customer an order belongs to. And a reviewer
-- reads a proposal better for knowing why it has come to a person at all.
--
-- Nothing here is part of what is approved. An approval names the proposal's own content;
-- the rows shown here are read at the moment of asking and may be different a moment later.
-- What must hold when the change is written belongs in a rule, which is read then.

-- The rows that a proposal's rows point to through foreign keys, one row here for each of
-- their columns, in the table's column order.
--
-- It runs with the caller's rights, so privileges and row-level security decide what is
-- shown. "state" is shown, missing (no such row, or none the caller's policies let through)
-- or unreadable (the caller may not read the table).
create function keyturn.refers_to(p_proposal_id uuid, p_from integer default 1, p_count integer default 100)
  returns table (seq integer, via text, relation text, key jsonb, state text, column_name text, value text, kind text)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  as $$
#variable_conflict use_column
declare
  change  keyturn.changes;
  link    record;
  image   jsonb;
  wanted  jsonb;
  held    jsonb;
  reading text;
  outcome text;
begin
  for change in
    select * from keyturn.changes c
     where c.proposal_id = p_proposal_id and c.seq >= p_from and c.seq < p_from::bigint + least(greatest(p_count, 0), 1000)
     order by c.seq
  loop
    -- A delete points where the row pointed; an insert or an update where the new row would.
    image := coalesce(change.after, change.before);
    for link in
      select con.conname::text as name, con.confrelid as target, con.confrelid::regclass::text as target_name,
             pairs.from_columns, pairs.to_columns, pairs.condition
        from pg_constraint con
        cross join lateral (
          select array_agg(f.attname::text order by part.position) as from_columns,
                 array_agg(t.attname::text order by part.position) as to_columns,
                 -- Compared with the equality the foreign key itself uses.
                 string_agg(format('t.%I operator(%I.%s) (select k.%I from pg_catalog.jsonb_to_record($1) as k (%I %s))',
                                   t.attname, n.nspname, o.oprname, f.attname, f.attname, format_type(f.atttypid, f.atttypmod)),
                            ' and ' order by part.position) as condition
            from unnest(con.conkey, con.confkey, con.conpfeqop) with ordinality as part (from_num, to_num, equal, position)
            join pg_attribute f on f.attrelid = con.conrelid and f.attnum = part.from_num
            join pg_attribute t on t.attrelid = con.confrelid and t.attnum = part.to_num
            join pg_operator o on o.oid = part.equal
            join pg_namespace n on n.oid = o.oprnamespace
        ) as pairs
       where con.conrelid = change.relation and con.contype = 'f'
       order by con.conname
    loop
      select jsonb_object_agg(name, image -> name) into wanted from unnest(link.from_columns) as name;
      -- A column not given, or null, points nowhere.
      if exists (select from jsonb_each(wanted) as part where jsonb_typeof(part.value) = 'null') then
        continue;
      end if;
      held := null;
      outcome := 'shown';
      begin
        execute format('select to_jsonb(t) from %s t where %s', link.target::regclass, link.condition) into held using wanted;
        if held is null then
          outcome := 'missing';
        end if;
      exception
        when insufficient_privilege then outcome := 'unreadable';
        when others then outcome := 'missing';
      end;
      if outcome <> 'shown' then
        return query select change.seq, link.name, link.target_name, wanted, outcome, null::text, null::text, null::text;
      else
        return query
          select change.seq, link.name, link.target_name, wanted, outcome, col.key, col.value #>> '{}', jsonb_typeof(col.value)
            from jsonb_each(held) as col
            left join pg_attribute a on a.attrelid = link.target and a.attname = col.key and a.attnum > 0
           order by a.attnum nulls last, col.key;
      end if;
    end loop;
  end loop;
end $$;

-- Why a proposal that is waiting has come to a person: for each change no rule covers, what
-- each rule for its table lacks. For an approver. An agent may not ask, as it may not read
-- the rules.
--
-- At most twenty changes are explained. A table with no rule at all is named once, and so
-- is a rule that the proposal as a whole is too large for: those rows have no "seq".
create function keyturn.waits_because(p_proposal_id uuid)
  returns table (seq integer, rule text, because text)
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
#variable_conflict use_column
declare
  change    keyturn.changes;
  candidate keyturn.rules;
  holds     boolean;
  total     integer;
  covered   boolean;
  why       text;
  names     text[];
  whys      text[];
  bare      oid[] := '{}';
  whole     text[] := '{}';
  shown     integer := 0;
  uncovered boolean := false;
  forbidden text;
begin
  if not keyturn.caller_is('keyturn_approver') then
    raise exception 'keyturn: % is not an approver', session_user using errcode = 'insufficient_privilege';
  end if;
  if not exists (select from keyturn.proposals p where p.id = p_proposal_id and p.status = 'pending') then
    return;
  end if;
  forbidden := keyturn.forbidden_in(p_proposal_id);
  if forbidden is not null then
    return query select null::integer, null::text, format('no one may approve this as things stand: %s', forbidden);
    return;
  end if;

  select count(*) into total from keyturn.changes c where c.proposal_id = p_proposal_id;
  for change in select * from keyturn.changes c where c.proposal_id = p_proposal_id order by c.seq loop
    covered := false;
    names := '{}';
    whys := '{}';
    for candidate in select * from keyturn.rules r where r.active and r.relation = change.relation order by r.name loop
      why := case
        when not (change.operation = any (candidate.operations)) then
          format('does not cover %s', case change.operation when 'insert' then 'an insert' when 'update' then 'an update' else 'a delete' end)
        when candidate.max_rows < total then
          format('lets through %s in a proposal, and this one holds %s', case candidate.max_rows when 1 then 'one row' else candidate.max_rows || ' rows' end, total)
        when change.operation <> 'delete' and not (change.columns <@ coalesce(candidate.columns, '{}')) then
          format('does not let %s be set',
                 (select string_agg(given.name, ', ' order by given.position) from unnest(change.columns) with ordinality as given (name, position)
                   where given.name <> all (coalesce(candidate.columns, '{}'))))
      end;
      if why is null and candidate.condition is not null then
        begin
          execute format('select (%s) from (select $1 as before, $2 as after) as change', candidate.condition) into holds using change.before, change.after;
          if holds is not true then
            why := 'has a condition that does not hold for this row';
          end if;
        exception when others then
          why := 'has a condition that could not be worked out for this row';
        end;
      end if;
      if why is null then
        covered := true;
        exit;
      end if;
      names := array_append(names, candidate.name);
      whys := array_append(whys, why);
    end loop;

    if not covered then
      uncovered := true;
      if cardinality(names) = 0 then
        if not (change.relation::oid = any (bare)) then
          bare := array_append(bare, change.relation::oid);
          return query select null::integer, null::text, format('no rule lets a change to %s through without a person', change.relation_name);
        end if;
      elsif shown < 20 then
        shown := shown + 1;
        for place in 1 .. cardinality(names) loop
          if whys[place] like 'lets through %' then
            -- True of the proposal, not of one change: said once for the rule.
            if not (names[place] = any (whole)) then
              whole := array_append(whole, names[place]);
              return query select null::integer, names[place], whys[place];
            end if;
          else
            return query select change.seq, names[place], whys[place];
          end if;
        end loop;
      end if;
    end if;
  end loop;

  if not uncovered and total > 0 then
    return query select null::integer, null::text,
      'every change is covered by a rule: it goes through when it is applied, unless a rule has let through all it may this hour'::text;
  end if;
end $$;

revoke all on function keyturn.refers_to(uuid, integer, integer), keyturn.waits_because(uuid) from public;
grant execute on function keyturn.refers_to(uuid, integer, integer) to keyturn_agent, keyturn_approver;
grant execute on function keyturn.waits_because(uuid) to keyturn_approver;
